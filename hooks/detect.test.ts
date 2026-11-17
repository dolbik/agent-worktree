import { expect, test } from 'claude-code/testing'

import { deepest, firstLine, parseLock, parseWorktreeList, resolvePath, worktreeAdds } from './detect'

test('worktreeAdds finds the folder git runs in and the path word', async () => {
  expect(worktreeAdds('git worktree add -q ../side -b side')).toEqual([{ dir: null, path: '../side' }])
  expect(worktreeAdds('git -C /other worktree add .claude/worktrees/z -b z')).toEqual([
    { dir: '/other', path: '.claude/worktrees/z' },
  ])
  expect(worktreeAdds('cd sub && git worktree add -b x ../x main')).toEqual([{ dir: 'sub', path: '../x' }])
  expect(worktreeAdds('git worktree add -- "my tree"')).toEqual([{ dir: null, path: 'my tree' }])
  expect(worktreeAdds('git worktree add "$DIR"')).toEqual([{ dir: null, path: null }])
  expect(worktreeAdds('git worktree list && git status')).toEqual([])
})

test('a heredoc body is not read as a command', async () => {
  const command = 'cat > notes.md <<EOF\ngit worktree add ../nope\nEOF\ngit worktree add ../yes'
  expect(worktreeAdds(command)).toEqual([{ dir: null, path: '../yes' }])
})

test('resolvePath joins and normalises against the folder and home', async () => {
  expect(resolvePath('/repo', '../side', '/home/u')).toBe('/side')
  expect(resolvePath('/repo', '~/x', '/home/u')).toBe('/home/u/x')
  expect(resolvePath('/repo/a', './b/../c', '/home/u')).toBe('/repo/a/c')
})

test('parseWorktreeList reads paths, branches and lock text', async () => {
  const porcelain = [
    'worktree /repo\nHEAD a\nbranch refs/heads/main',
    'worktree /repo/.claude/worktrees/build\nHEAD b\nbranch refs/heads/worktree-build\nlocked claude session build (pid 88572 start Tue Nov 17 07:25:46 2026)',
    'worktree /side\nHEAD c\ndetached\nlocked',
  ].join('\n\n')
  expect(parseWorktreeList(porcelain)).toEqual([
    { path: '/repo', branch: 'main', lock: undefined },
    {
      path: '/repo/.claude/worktrees/build',
      branch: 'worktree-build',
      lock: 'claude session build (pid 88572 start Tue Nov 17 07:25:46 2026)',
    },
    { path: '/side', branch: undefined, lock: '' },
  ])
})

test('parseLock reads the pid and start of a Claude Code lock', async () => {
  expect(parseLock('claude session build (pid 88572 start Tue Nov 17 07:25:46 2026)')).toEqual({
    pid: 88572,
    startedAt: 'Tue Nov 17 07:25:46 2026',
  })
  expect(parseLock('kept by hand')).toBeNull()
})

test('deepest picks the innermost worktree holding a folder', async () => {
  const paths = ['/repo/.claude/worktrees/build', '/repo/.claude/worktrees/build/.worktrees/inner', '/side']
  expect(deepest('/repo/.claude/worktrees/build/.worktrees/inner/src', paths)).toBe(
    '/repo/.claude/worktrees/build/.worktrees/inner',
  )
  expect(deepest('/repo/.claude/worktrees/build/src', paths)).toBe('/repo/.claude/worktrees/build')
  expect(deepest('/repo/.claude/worktrees/builder', paths)).toBeUndefined()
})

test('firstLine gives the cause of a failed call', async () => {
  expect(firstLine('Exit code 128\nfatal: invalid reference: .')).toBe('invalid reference: .')
  expect(firstLine('<tool_use_error>EnterWorktree cannot create a worktree</tool_use_error>')).toBe(
    'EnterWorktree cannot create a worktree',
  )
  expect(firstLine("Preparing worktree (checking out 'b')\nfatal: 'b' is already used by worktree at '/x'")).toBe(
    "'b' is already used by worktree at '/x'",
  )
})
