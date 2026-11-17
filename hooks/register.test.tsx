import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
type Git = (argv: readonly string[], cwd?: string) => string | undefined

const PANE = {
  plugin: 'agent-worktree',
  component: 'Pane',
  requestId: 'agent-worktree',
  props: {
    title: 'Worktrees',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'agent-worktree',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 3,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  },
} as const

const WT = '/repo/.claude/worktrees/fix-auth'
const AGENT_WT = '/repo/.claude/worktrees/agent-1'

const worktreeList = (...paths: string[]) =>
  [
    'worktree /repo\nHEAD a\nbranch refs/heads/main',
    ...paths.map(path => `worktree ${path}\nHEAD b\nbranch refs/heads/worktree-${path.split('/').pop()}`),
  ].join('\n\n')

const repoGit =
  (paths: string[], per: Record<string, string> = {}): Git =>
  argv => {
    const key = argv[1] === 'diff' ? `diff ${argv[2]}` : (argv[1] ?? '')
    const answers: Record<string, string> = {
      worktree: worktreeList(...paths),
      'rev-parse': 'worktree-fix-auth',
      status: '?? b.txt',
      'rev-list': '0\t1',
      'diff --shortstat': ' 1 file changed, 1 insertion(+)',
      'diff --name-status': 'A\ta.txt',
      log: 'Add a\u00000 seconds ago',
      ...per,
    }

    return answers[key]
  }

const agentRow = (status: string, tokenCount = 45000) =>
  ({
    id: 'ag1',
    description: 'fix auth',
    label: 'fix auth',
    status,
    model: 'opus',
    tokenCount,
    tokenSamples: [1000, 20000, 45000],
    startTime: 0,
    cwd: AGENT_WT,
  }) as never

type Engine = { sent: string[]; toasts: string[]; views: string[]; agents: { rows: never[] } }

const engine = (on: On, git: Git | undefined): Engine => {
  const seen: Engine = { sent: [], toasts: [], views: [], agents: { rows: [] } }
  on('command.register', () => ({ value: { command: 'worktrees' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 3 * 60000 }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.view', (_, e) => {
    seen.views.push(e.agentId ?? '')

    return { value: {} as never }
  })
  on('agent.list', () => ({ value: seen.agents.rows }))
  on('fs.exists', () => ({ value: true }))
  on('process.run', (_, e) => {
    const stdout = git?.(e.argv, e.init?.cwd)

    return {
      value: {
        exitCode: stdout === undefined ? 128 : 0,
        stdout: stdout ?? '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('prompt.submit', (_, e) => {
    seen.sent.push(e.text)

    return { text: e.text }
  })
  on('tool.call', { tool: 'EnterWorktree' }, () => ({
    result: { worktreePath: WT, worktreeBranch: 'worktree-fix-auth', message: 'ok' },
  }))

  return seen
}

const start = async ($: Parameters<TestBody>[0]) =>
  $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

test('EnterWorktree is tracked, drawn, and Investigate sends a read-only prompt', async ($, on) => {
  const seen = engine(on, undefined)
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /fix-auth/ }))?.text).toContain('★ here')
    await ui.press({ key: `${WT}:Investigate` })
    await ui.unmount()
  }

  expect(seen.sent.length).toBe(2)
  expect(seen.sent[0]).toContain(WT)
  expect(seen.sent[0]).toContain('Read-only')
  expect(seen.sent[0]).toContain('its upstream or default branch')
})

test('git output becomes the card numbers and the file list', async ($, on) => {
  const seen = engine(on, repoGit([WT]))
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /↑/ }))?.text).toBe('worktree-fix-auth  ↑1 ↓0 main · 1 dirty')
  expect((await ui.find({ type: 'Text', text: /█/ }))?.text).toMatch(/^█+ \+1 −0 · 1 files$/)
  expect((await ui.find({ type: 'Text', text: /^base/ }))?.text).toBe('base main')
  expect(await ui.find({ type: 'Text', text: /a\.txt/ })).toBeUndefined()
  await ui.press({ key: `${WT}:files` })
  expect((await ui.find({ type: 'Text', text: /a\.txt/ }))?.text).toBe('  A  a.txt')
  expect((await ui.find({ type: 'Text', text: /b\.txt/ }))?.text).toBe('  ?? b.txt (uncommitted)')
  await ui.press({ key: `${WT}:Review diff` })
  await ui.unmount()

  expect(seen.sent[0]).toContain('git diff main...worktree-fix-auth')
})

test('agent and ExitWorktree badges', async ($, on) => {
  engine(on, undefined)
  on('tool.call', { tool: 'Agent' }, () => ({
    result: { status: 'completed', worktreePath: AGENT_WT, worktreeBranch: 'worktree-agent-1' } as never,
  }))
  on('tool.call', { tool: 'ExitWorktree' }, () => ({
    result: { action: 'remove', originalCwd: '/repo', worktreePath: WT } as never,
  }))

  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })
  await $.tool.call({ tool: 'Agent', prompt: 'fix it', description: 'fix auth', isolation: 'worktree' })
  await $.tool.call({ tool: 'ExitWorktree', action: 'remove' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const agent = await ui.find({ type: 'Text', text: /⎇ agent-1/ })
  expect(agent?.text).toContain('agent "fix auth"')
  expect(agent?.text).not.toContain('running')
  const exited = await ui.find({ type: 'Text', text: /⎇ fix-auth/ })
  expect(exited?.text).toContain('removed')
  expect(exited?.text).not.toContain('★ here')
  await ui.unmount()
})

test('a background agent gets its worktree, live badge, View, and a done toast', async ($, on) => {
  const seen = engine(on, repoGit([AGENT_WT]))
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched' } as never }))
  seen.agents.rows = [agentRow('running')]

  await start($)
  await $.tool.call({ tool: 'Agent', prompt: 'fix it', description: 'fix auth', isolation: 'worktree' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /⎇ agent-1/ }))?.text).toContain('agent "fix auth"')
  expect((await ui.find({ type: 'Text', text: /●/ }))?.text).toBe('● running · opus · 45k tok · 3m ▁▄█')
  expect(await ui.find({ type: 'Text', text: /Other Claude worktrees/ })).toBeUndefined()
  await ui.press({ key: `${AGENT_WT}:view` })
  expect(seen.views).toEqual(['ag1'])

  await ui.press({ key: 'refresh' })
  expect(seen.toasts).toEqual([])
  seen.agents.rows = [agentRow('completed')]
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'refresh' })
  expect(seen.toasts).toEqual(['agent "fix auth" done: ↑1 · 2 files'])
  seen.agents.rows = [agentRow('completed', 1_234_567)]
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /●/ }))?.text).toContain('1.2M tok')
  await ui.unmount()
})

test('two worktrees touching one file warn on both cards and in the band', async ($, on) => {
  engine(on, repoGit([WT, AGENT_WT], { 'diff --name-status': 'M\tsrc/a.ts' }))
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /overlaps agent-1/ }))?.text).toContain('src/a.ts')
  expect((await ui.find({ type: 'Text', text: /overlaps fix-auth/ }))?.text).toContain('src/a.ts')
  await ui.unmount()

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /worktrees/ }))?.text).toBe(
    '⎇ 2 worktrees · 2 dirty · 0 running · 2 overlap',
  )
  await band.unmount()
})

test('a branch with nothing unmerged and no edits gets the clean badge', async ($, on) => {
  engine(on, repoGit([WT], { status: '', 'rev-list': '0\t0', 'diff --name-status': '', 'diff --shortstat': '' }))
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /⎇ fix-auth/ }))?.text).toContain('nothing unmerged · clean')
  await ui.unmount()
})

test('outside a git repo the header says so and the band stays out', async ($, on) => {
  engine(on, undefined)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /git repo/ }))?.text).toBe('no git repo')
  expect(await ui.find({ type: 'Text', text: /^base/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /No worktrees/ }))?.text).toBe(
    'No worktrees in this session yet.',
  )
  await ui.unmount()

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /worktree/ })).toBeUndefined()
  await band.unmount()
})

test('a narrow pane drops the bar and shortens the buttons', async ($, on) => {
  engine(on, repoGit([WT]))
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })

  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 50 }, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /↑/ }))?.text).toBe('worktree-fix-auth  ↑1 ↓0 main · 1 dirty +1 −0')
  expect(await ui.find({ type: 'Text', text: /█/ })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: `${WT}:Investigate` }))?.text).toBe('Inv')
  await ui.unmount()
})

test('the diff bar scales each card against the largest diff', async ($, on) => {
  const base = repoGit([WT, AGENT_WT])
  engine(on, (argv, cwd) =>
    argv[1] === 'diff' && argv[2] === '--shortstat'
      ? cwd === WT
        ? ' 1 file changed, 1 insertion(+), 1 deletion(-)'
        : ' 1 file changed, 4 insertions(+)'
      : base(argv, cwd),
  )
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /\+1 −1/ }))?.text).toBe(
    `${'█'.repeat(12)}${'░'.repeat(12)} +1 −1 · 1 files`,
  )
  expect((await ui.find({ type: 'Text', text: /\+4 −0/ }))?.text).toBe(`${'█'.repeat(24)} +4 −0 · 1 files`)
  expect((await ui.find({ type: 'Text', text: /^█{6}$/ }))?.text).toBe('█'.repeat(6))
  await ui.unmount()
})
