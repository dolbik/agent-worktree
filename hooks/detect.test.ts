import { expect, test } from 'claude-code/testing'

import {
  deepest,
  firstLine,
  branchesIn,
  branchesMade,
  isMadeLine,
  madeIn,
  parseLock,
  parseWorktreeList,
  resolvePath,
  utf8Length,
  wholeLines,
  worktreeAdds,
} from './detect'

test('worktreeAdds finds the folder git runs in and the path word', async () => {
  expect(worktreeAdds('git worktree add -q ../side -b side')).toEqual([{ dir: null, path: '../side' }])
  expect(worktreeAdds('git -C /other worktree add .claude/worktrees/z -b z')).toEqual([
    { dir: '/other', path: '.claude/worktrees/z' },
  ])
  expect(worktreeAdds('cd sub && git worktree add -b x ../x main')).toEqual([{ dir: 'sub', path: '../x' }])
  expect(worktreeAdds('git worktree add -- "my tree"')).toEqual([{ dir: null, path: 'my tree' }])
  expect(worktreeAdds('git worktree add "$DIR"')).toEqual([{ dir: null, path: null }])
  expect(worktreeAdds('cd "$REPO" && git worktree add ../wt')).toEqual([])
  expect(worktreeAdds('cd /tmp && cd ~/repo && git worktree add x')).toEqual([{ dir: '~/repo', path: 'x' }])
  expect(worktreeAdds('cd "$REPO" && cd /abs && git worktree add x')).toEqual([{ dir: '/abs', path: 'x' }])
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

test('wholeLines keeps only whole lines and counts their bytes', async () => {
  expect(wholeLines('a\nбв\nhalf', false)).toEqual({ lines: ['a', 'бв'], bytes: 7 })
  expect(wholeLines('a\nlast', true)).toEqual({ lines: ['a', 'last'], bytes: 6 })
  expect(wholeLines('no break at all', false)).toEqual({ lines: [], bytes: 0 })
  expect(utf8Length('aб€😀')).toBe(1 + 2 + 3 + 4)
})

test('madeIn reads made and entered worktrees from transcript lines', async () => {
  const lines = [
    JSON.stringify({
      type: 'assistant',
      cwd: '/repo',
      timestamp: '2026-11-12T08:38:41.000Z',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'cd /other && git worktree add -q -b x .claude/worktrees/x main' },
          },
          { type: 'tool_use', name: 'Bash', input: { command: 'git -C "$A" worktree add "$A/wt"' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      cwd: '/repo',
      timestamp: '2026-11-12T09:00:00.000Z',
      toolUseResult: {
        worktreePath: '/repo/.claude/worktrees/y',
        worktreeBranch: 'y',
        message: 'Created worktree at /repo',
      },
    }),
    JSON.stringify({
      type: 'user',
      toolUseResult: { worktreePath: '/repo/.claude/worktrees/y', message: 'Exited worktree. Your work is preserved' },
    }),
    'not json',
  ]
  expect(lines.filter(isMadeLine).length).toBe(3)
  expect(madeIn(lines, '/home/u', { agentId: 's1', label: 'helper' })).toEqual([
    {
      path: '/other/.claude/worktrees/x',
      how: 'bash',
      at: Date.parse('2026-11-12T08:38:41.000Z'),
      agentId: 's1',
      label: 'helper',
    },
    {
      path: '/repo/.claude/worktrees/y',
      how: 'enter',
      at: Date.parse('2026-11-12T09:00:00.000Z'),
      agentId: 's1',
      label: 'helper',
    },
  ])
})

test('branchesMade finds branches a command creates and where', async () => {
  expect(branchesMade('git fetch -q origin main && git switch -c fix/a origin/main')).toEqual([
    { dir: null, branch: 'fix/a' },
  ])
  expect(branchesMade('cd /w && git checkout -B fix/b')).toEqual([{ dir: '/w', branch: 'fix/b' }])
  expect(branchesMade('git -C /r worktree add -b fix/c .claude/worktrees/c main')).toEqual([
    { dir: '/r/.claude/worktrees/c', branch: 'fix/c' },
  ])
  expect(branchesMade('git switch main; git checkout -b "$B"; git branch fix/d')).toEqual([])
  expect(isMadeLine('{"name":"Bash","input":{"command":"git switch -c x"}}')).toBe(true)
  expect(isMadeLine('{"name":"Bash","input":{"command":"git switch x"}}')).toBe(false)
  expect(
    branchesIn(
      [
        JSON.stringify({
          cwd: '/w',
          timestamp: '2026-11-11T13:48:00.000Z',
          message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git switch -c fix/e' } }] },
        }),
      ],
      '/h',
    ),
  ).toEqual([{ dir: '/w', branch: 'fix/e', at: Date.parse('2026-11-11T13:48:00.000Z') }])
})
