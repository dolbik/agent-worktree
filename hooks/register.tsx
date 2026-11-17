import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register } from 'claude-code'

import type { AgentBadge, FileChange, Snap } from '../types'

const PANE = 'agent-worktree'
const TITLE = 'Worktrees'
const READ_ONLY =
  'Read-only: do not modify, switch into, merge or remove the worktree.'
const ACTIVE = ['pending', 'running', 'waiting']
const ENDED = ['completed', 'failed', 'killed']

const tracked = atom({ plugin: 'agent-worktree', key: 'tracked' } as const, [], {
  shape: 'tracked-1',
})
const grove = atom(
  { plugin: 'agent-worktree', key: 'grove' } as const,
  { others: [], snaps: {}, agents: {} },
  { shape: 'grove-3' },
)
const expanded = atom({ plugin: 'agent-worktree', key: 'expanded' } as const, [], {
  shape: 'expanded-1',
})

const git = async ($: EngineInterface, cwd: string, ...args: string[]) => {
  const ran = await $.process.run(['git', ...args], { cwd })

  // trimEnd only: `status --porcelain` lines start with a meaningful space
  return ran.exitCode === 0 ? ran.stdout.trimEnd() : undefined
}

const lines = (text?: string) => (text ? text.split('\n') : [])
const nameOf = (path: string) => path.split('/').pop() || path

const snapOf = async ($: EngineInterface, path: string, base?: string): Promise<Snap> => {
  if (!(await $.fs.exists(path))) return { isGone: true, ahead: 0, behind: 0, dirty: 0, files: [] }

  const [branch, status, counts, shortstat, nameStatus, last] = await Promise.all([
    git($, path, 'rev-parse', '--abbrev-ref', 'HEAD'),
    git($, path, 'status', '--porcelain'),
    base ? git($, path, 'rev-list', '--left-right', '--count', `${base}...HEAD`) : undefined,
    base ? git($, path, 'diff', '--shortstat', `${base}...HEAD`) : undefined,
    base ? git($, path, 'diff', '--name-status', `${base}...HEAD`) : undefined,
    git($, path, 'log', '-1', '--format=%s%x00%cr'),
  ])
  const [behind = 0, ahead = 0] = (counts ?? '').trim().split(/\s+/).map(Number)
  const [lastSubject, lastAge] = (last ?? '').split('\0')
  const committed: FileChange[] = lines(nameStatus).map(line => {
    const parts = line.split('\t')

    return { status: parts[0]?.[0] ?? '?', path: parts[parts.length - 1] ?? '', isUncommitted: false }
  })
  const seen = new Set(committed.map(file => file.path))
  const uncommitted: FileChange[] = lines(status)
    .map(line => ({
      status: line.slice(0, 2).trim() || '?',
      path: line.slice(3).split(' -> ').pop() ?? '',
      isUncommitted: true,
    }))
    .filter(file => !seen.has(file.path))

  return {
    isGone: false,
    branch,
    base,
    ahead: ahead || 0,
    behind: behind || 0,
    dirty: lines(status).length,
    shortstat: shortstat?.trim() || undefined,
    lastSubject: lastSubject || undefined,
    lastAge,
    files: [...committed, ...uncommitted],
  }
}

const isInside = (cwd: string, path: string) => cwd === path || cwd.startsWith(`${path}/`)

const badgeOf = (agent: AgentInfo): AgentBadge => ({
  id: agent.id,
  label: agent.description || agent.label,
  status: agent.status,
  model: agent.model,
  tokenCount: agent.tokenCount,
  samples: agent.tokenSamples,
  startTime: agent.startTime,
})

const refresh = async ($: EngineInterface) => {
  const before = await read($, tracked)
  const cwd = before.find(one => one.isHere)?.path ?? (await $.session.cwd())
  const porcelain = await git($, cwd, 'worktree', 'list', '--porcelain')
  const entries = (porcelain ?? '').split('\n\n').map(block => ({
    path: block.match(/^worktree (.*)$/m)?.[1] ?? '',
    branch: block.match(/^branch refs\/heads\/(.*)$/m)?.[1],
  }))
  const main = entries[0]
  const worktrees = entries.slice(1).map(one => one.path)
  const agents = await $.agent.list()

  // a background agent's call answers before its worktree exists: place it by its agent row's cwd
  const pathFor = (label?: string) => {
    const agent = agents.find(one => (one.description || one.label) === label)

    return agent && worktrees.find(path => isInside(agent.cwd, path))
  }
  if (before.some(one => one.path === '' && pathFor(one.label))) {
    await update($, tracked, list =>
      list.map(one => (one.path === '' ? { ...one, path: pathFor(one.label) ?? '' } : one)),
    )
  }

  const list = await read($, tracked)
  const mine = new Set(list.map(one => one.path))
  const others = worktrees.filter(path => path.includes('/.claude/worktrees/') && !mine.has(path))
  const paths = [...list.map(one => one.path).filter(Boolean), ...others]
  const snaps = Object.fromEntries(
    await Promise.all(paths.map(async path => [path, await snapOf($, path, main?.branch)] as const)),
  )
  const badges: Record<string, AgentBadge> = {}
  for (const path of paths) {
    const agent = agents
      .filter(one => isInside(one.cwd, path))
      .sort((a, b) => b.startTime - a.startTime)[0]
    if (agent) badges[path] = badgeOf(agent)
  }

  const previous = (await read($, grove)).agents
  for (const [path, badge] of Object.entries(badges)) {
    const was = previous[path]
    if (was?.id !== badge.id || !ACTIVE.includes(was.status) || !ENDED.includes(badge.status)) continue
    const snap = snaps[path]
    const word = badge.status === 'completed' ? 'done' : badge.status
    $.ui.toast(`agent "${badge.label}" ${word}: ↑${snap?.ahead ?? 0} · ${snap?.files.length ?? 0} files`)
  }

  await update($, grove, () => ({
    repo: main?.path.split('/').pop() || undefined,
    base: main?.branch,
    others,
    snaps,
    agents: badges,
  }))
}

const overlapsOf = (snaps: Record<string, Snap>, paths: string[]) =>
  Object.fromEntries(
    paths.map(path => {
      const mine = new Set(snaps[path]?.files.map(file => file.path))
      const hits = paths
        .filter(other => other !== path)
        .map(other => ({
          other,
          files: (snaps[other]?.files ?? []).map(file => file.path).filter(file => mine.has(file)),
        }))
        .filter(hit => hit.files.length > 0)

      return [path, hits] as const
    }),
  )

const prompts = (path: string, branch: string, base?: string) => {
  const against = base ?? 'its upstream or default branch'
  const diff = base ? ` (git diff ${base}...${branch})` : ''

  return {
    Investigate: `Investigate the git worktree at ${path} (branch ${branch}): summarize what was done there, how it stands against ${against}, and any uncommitted work. ${READ_ONLY}`,
    'Review diff': `Review the changes on branch ${branch} against ${against}${diff} in the worktree at ${path} for correctness bugs. ${READ_ONLY}`,
    'Cleanup check': `Check whether the worktree at ${path} (branch ${branch}) is safe to remove: is it merged into ${against}, does it hold uncommitted files, is an agent still working in it? Report only, change nothing. ${READ_ONLY}`,
  }
}

const SPARK = '▁▂▃▄▅▆▇█'
const BAR_WIDTH = 24

const diffOf = (snap?: Snap) => {
  const stat = snap?.shortstat?.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/)

  return stat ? { files: Number(stat[1]), add: Number(stat[2] ?? 0), del: Number(stat[3] ?? 0) } : undefined
}

const barOf = (add: number, del: number, scale: number, width: number) => {
  const cells = (n: number) => (n > 0 ? Math.max(1, Math.round((n / scale) * width)) : 0)
  const green = cells(add)
  const red = Math.min(cells(del), width - green)

  return { green: '█'.repeat(green), red: '█'.repeat(red), rest: '░'.repeat(Math.max(0, width - green - red)) }
}

const sparkOf = (samples: number[]) => {
  if (samples.length < 2) return ''
  const low = Math.min(...samples)
  const high = Math.max(...samples)

  return samples.map(n => SPARK[high === low ? 0 : Math.round(((n - low) / (high - low)) * 7)]).join('')
}

const tokensOf = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

const livePaths = (list: { path: string; isRemoved: boolean }[], others: string[]) => [
  ...list.filter(one => one.path && !one.isRemoved).map(one => one.path),
  ...others,
]

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: TITLE })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'worktrees',
      description: "Show this session's git worktrees in a pane",
    })
    void refresh($)
    $.clock.every(5000, () => void refresh($))

    return started
  })

  on('command.run', { command: 'worktrees' }, async $ => {
    await refresh($)
    await openPane($)

    return { text: 'Worktrees pane opened.' }
  })

  on('tool.call', { tool: 'EnterWorktree' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const { worktreePath: path, worktreeBranch: branch } = ran.result
    const before = await read($, tracked)
    await update($, tracked, list => [
      ...list
        .filter(one => one.path !== path)
        .map(one => ({ ...one, isHere: false })),
      {
        ...(list.find(one => one.path === path) ?? {
          source: 'enter' as const,
          isRunning: false,
          isRemoved: false,
          toolUseId: e.tool_use_id,
        }),
        path,
        branch,
        isHere: true,
      },
    ])
    $.ui.status(`⎇ ${branch ?? nameOf(path)}`)
    if (before.length === 0) void openPane($)

    return ran
  })

  on('tool.call', { tool: 'ExitWorktree' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const { worktreePath, action } = ran.result
    await update($, tracked, list =>
      list.map(one => ({
        ...one,
        isHere: false,
        isRemoved: one.isRemoved || (action === 'remove' && one.path === worktreePath),
      })),
    )
    $.ui.status(undefined)

    return ran
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.isolation !== 'worktree') return next(e)
    const before = await read($, tracked)
    await update($, tracked, list => [
      ...list,
      {
        path: '',
        source: 'agent' as const,
        label: e.description,
        isRunning: true,
        isHere: false,
        isRemoved: false,
        toolUseId: e.tool_use_id,
      },
    ])
    if (before.length === 0) void openPane($)
    const ran = await next(e)
    const result = (ran.result ?? {}) as {
      worktreePath?: string
      worktreeBranch?: string
      status?: string
    }
    await update($, tracked, list =>
      list
        .map(one =>
          one.toolUseId === e.tool_use_id
            ? {
                ...one,
                path: result.worktreePath ?? one.path,
                branch: result.worktreeBranch ?? one.branch,
                isRunning: false,
              }
            : one,
        )
        // a finished agent with no worktreePath left nothing on disk
        .filter(one => one.toolUseId !== e.tool_use_id || one.path !== '' || result.status !== 'completed'),
    )

    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, tracked)
    const { others, snaps, agents } = await read($, grove)
    const paths = livePaths(list, others)
    if (e.props.hasSurvey || paths.length === 0) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const overlaps = overlapsOf(snaps, paths)
    const count = (n: number, word: string, color: 'warning' | 'success') => (
      <Text color={n > 0 ? color : undefined} dimColor={n === 0}>
        {n} {word}
      </Text>
    )

    return (
      <Box flexDirection="row" gap={1}>
        <Text>
          <Text color="claude">
            ⎇ {paths.length} worktree{paths.length === 1 ? '' : 's'}
          </Text>
          <Text dimColor> · </Text>
          {count(paths.filter(path => (snaps[path]?.dirty ?? 0) > 0).length, 'dirty', 'warning')}
          <Text dimColor> · </Text>
          {count(paths.filter(path => ACTIVE.includes(agents[path]?.status ?? '')).length, 'running', 'success')}
          <Text dimColor> · </Text>
          {count(paths.filter(path => (overlaps[path]?.length ?? 0) > 0).length, 'overlap', 'warning')}
        </Text>
        <Button key="open" onPress={() => void openPane($)}>
          Open
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, tracked)
    const { repo, base, others, snaps, agents } = await read($, grove)
    const open = await read($, expanded)
    const now = await $.clock.now()
    const overlaps = overlapsOf(snaps, livePaths(list, others))
    const isNarrow = e.props.bodyColumns < 60
    const scale = Math.max(1, ...Object.values(snaps).map(snap => (diffOf(snap)?.add ?? 0) + (diffOf(snap)?.del ?? 0)))
    const ask = (text: string) => () => void $.prompt.submit({ text })
    const toggle = (key: string) => () =>
      void update($, expanded, keys => (keys.includes(key) ? keys.filter(one => one !== key) : [...keys, key]))
    const short: Record<string, string> = { Investigate: 'Inv', 'Review diff': 'Diff', 'Cleanup check': 'Clean' }
    const fileColor = (status: string) =>
      status === 'A' ? 'success' : status === 'D' ? 'error' : status === '??' ? undefined : 'warning'

    const card = (key: string, path: string, title: string, badges: (string | undefined)[], tone: 'here' | 'plain' | 'dim') => {
      const snap = snaps[path]
      const agent = agents[path]
      const isActive = !!agent && ACTIVE.includes(agent.status)
      const isDim = tone === 'dim'
      const branch = snap?.branch ?? nameOf(path)
      const files = snap?.files ?? []
      const diff = diffOf(snap)
      const bar = diff && barOf(diff.add, diff.del, scale, BAR_WIDTH)
      const spark = agent ? sparkOf(agent.samples) : ''
      const isMerged = !!snap && !snap.isGone && !!snap.base && snap.ahead === 0 && snap.dirty === 0
      const badge = [...badges, isMerged ? 'nothing unmerged · clean' : undefined].filter(Boolean).join(' · ')
      const isOpen = open.includes(key)

      return (
        <Box
          key={key}
          flexDirection="column"
          borderStyle="round"
          borderColor={tone === 'here' ? 'claude' : isActive ? 'success' : 'subtle'}
          borderDimColor={isDim}
          paddingX={1}
        >
          <Text bold={!isDim} dimColor={isDim}>
            ⎇ {title} <Text dimColor>{badge}</Text>
          </Text>
          {!snap && <Text dimColor>scanning…</Text>}
          {snap?.isGone && <Text color="error">gone from disk</Text>}
          {snap && !snap.isGone && (
            <Text>
              <Text dimColor>{branch}</Text>
              {snap.base && (
                <Text>
                  {'  '}
                  <Text color={snap.ahead ? 'success' : undefined} dimColor={!snap.ahead}>↑{snap.ahead}</Text>{' '}
                  <Text color={snap.behind ? 'warning' : undefined} dimColor={!snap.behind}>↓{snap.behind}</Text>
                  <Text dimColor> {snap.base}</Text>
                </Text>
              )}
              <Text dimColor> · </Text>
              {snap.dirty ? <Text color="warning">{snap.dirty} dirty</Text> : <Text color="success">clean</Text>}
              {isNarrow && diff && (
                <Text>
                  {' '}<Text color="success">+{diff.add}</Text> <Text color="error">−{diff.del}</Text>
                </Text>
              )}
            </Text>
          )}
          {!isNarrow && diff && bar && (
            <Text>
              <Text color="success">{bar.green}</Text>
              <Text color="error">{bar.red}</Text>
              <Text dimColor>{bar.rest}</Text>{' '}
              <Text color="success">+{diff.add}</Text> <Text color="error">−{diff.del}</Text>
              <Text dimColor> · {diff.files} files</Text>
            </Text>
          )}
          {!isNarrow && snap?.lastSubject && (
            <Text dimColor>
              {snap.lastSubject} · {snap.lastAge}
            </Text>
          )}
          {agent && (
            <Text dimColor={!isActive}>
              <Text color={isActive ? 'success' : undefined}>●</Text> {agent.status}
              {agent.model ? ` · ${agent.model}` : ''} · {tokensOf(agent.tokenCount)} tok ·{' '}
              {Math.max(0, Math.round((now - agent.startTime) / 60000))}m
              {!isNarrow && spark && <Text color="claude"> {spark}</Text>}
            </Text>
          )}
          {(overlaps[path] ?? []).map(hit => (
            <Text color="warning">
              ⚠ overlaps {nameOf(hit.other)}: {hit.files.slice(0, 2).join(', ')}
              {hit.files.length > 2 ? ` (+${hit.files.length - 2})` : ''}
            </Text>
          ))}
          {isOpen &&
            files.slice(0, 20).map(file => (
              <Text>
                {'  '}<Text color={fileColor(file.status)} dimColor={file.status === '??'}>{file.status.padEnd(2)}</Text>{' '}
                {file.path}
                {file.isUncommitted ? <Text dimColor> (uncommitted)</Text> : ''}
              </Text>
            ))}
          {isOpen && files.length > 20 && <Text dimColor>  +{files.length - 20} more</Text>}
          {path && !snap?.isGone && (
            <Box flexDirection="row" gap={1}>
              {Object.entries(prompts(path, branch, snap?.base ?? base)).map(([label, text]) => (
                <Button key={`${path}:${label}`} onPress={ask(text)}>
                  {isNarrow ? (short[label] ?? label) : label}
                </Button>
              ))}
              {files.length > 0 && (
                <Button key={`${path}:files`} onPress={toggle(key)}>
                  {isOpen ? 'Hide files' : `Files (${files.length})`}
                </Button>
              )}
              {agent && (
                <Button key={`${path}:view`} onPress={() => void $.ui.view({ agentId: agent.id })}>
                  {isNarrow ? 'View' : 'View agent'}
                </Button>
              )}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          {repo ? (
            <Text bold color="claude">
              {repo}
            </Text>
          ) : (
            <Text dimColor>no git repo</Text>
          )}
          {repo && base && <Text dimColor>base {base}</Text>}
          <Button key="refresh" onPress={() => void refresh($)}>
            Refresh
          </Button>
        </Box>
        {list.length === 0 && <Text dimColor>No worktrees in this session yet.</Text>}
        {list.map(one =>
          card(
            one.toolUseId,
            one.path,
            nameOf(one.path) || '(creating…)',
            [
              one.isHere ? '★ here' : undefined,
              one.source === 'agent' ? `agent "${one.label ?? ''}"` : 'EnterWorktree',
              one.isRunning ? 'running' : undefined,
              one.isRemoved ? 'removed' : undefined,
            ],
            one.isRemoved ? 'dim' : one.isHere ? 'here' : 'plain',
          ),
        )}
        {others.length > 0 && <Text dimColor>Other Claude worktrees</Text>}
        {others.map(path => card(path, path, nameOf(path), ['not from this session'], 'dim'))}
      </Box>
    )
  })
}
