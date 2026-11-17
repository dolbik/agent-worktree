import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface } from 'claude-code'

import type { Problem, Row, Snap, Tracked } from '../types'
import { ACTIVE, PANE, liveTracked, nameOf, refresh } from './scan'

const tracked = atom({ plugin: 'agent-worktree', key: 'tracked' } as const, [], { shape: 'tracked-2' })
const grove = atom(
  { plugin: 'agent-worktree', key: 'grove' } as const,
  { repoOf: {}, others: [], rowsAt: 0, snaps: {}, agents: {} },
  { shape: 'grove-5' },
)
const problems = atom({ plugin: 'agent-worktree', key: 'problems' } as const, [], { shape: 'problems-1' })
const expanded = atom({ plugin: 'agent-worktree', key: 'expanded' } as const, [], { shape: 'expanded-1' })

const READ_ONLY = 'Read-only: do not modify, switch into, merge or remove the worktree.'
const SPARK = '▁▂▃▄▅▆▇█'
const BAR_WIDTH = 24
const PROBLEMS_SHOWN = 5

export function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: 'Worktrees' })
}

const isAgentMade = (one: Tracked) => one.agentId !== undefined || one.how === 'agent'

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

const two = (n: number) => String(n).padStart(2, '0')
export const clockOf = (at: number) => {
  const date = new Date(at)

  return `${two(date.getHours())}:${two(date.getMinutes())}`
}

const fit = (text: string, width: number) => (text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`)
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export const madeBy = (one: Tracked) => {
  const who = isAgentMade(one) ? `subagent «${one.label ?? one.agentId ?? ''}»` : 'this session'
  const how = {
    enter: 'EnterWorktree',
    entered: 'EnterWorktree',
    bash: 'git worktree add',
    lock: one.agentId === undefined ? 'EnterWorktree' : undefined,
    agent: one.isBackground ? 'background' : undefined,
  }[one.how]
  const at = one.at === undefined ? '' : ` at ${clockOf(one.at)}`

  return `${one.how === 'entered' ? 'entered by' : 'made by'} ${who}${at}${how ? ` · ${how}` : ''}`
}

const rowFacts = (row: Row) =>
  row.isGone ? 'folder gone' : row.ahead === undefined ? '' : `↑${row.ahead} ↓${row.behind} · ${row.age ?? ''}`

export async function drawPane($: EngineInterface, ui: ElementTable, width: number) {
  const { Box, Text, Button } = ui
  const list = await read($, tracked)
  const { repoOf, others, snaps, agents } = await read($, grove)
  const failed = await read($, problems)
  const open = await read($, expanded)
  const now = await $.clock.now()
  const isNarrow = width < 60
  const live = liveTracked(list)
  const overlaps = overlapsOf(
    snaps,
    live.map(one => one.path),
  )
  const scale = Math.max(
    1,
    ...live.map(one => (diffOf(snaps[one.path])?.add ?? 0) + (diffOf(snaps[one.path])?.del ?? 0)),
  )
  const repos = [...new Set([...live.map(one => repoOf[one.path]), ...others.map(row => row.repo)].filter(Boolean))]
  const ask = (text: string) => () => void $.prompt.submit({ text })
  const toggle = (key: string) => () =>
    void update($, expanded, keys => (keys.includes(key) ? keys.filter(one => one !== key) : [...keys, key]))
  const short: Record<string, string> = { Investigate: 'Inv', 'Review diff': 'Diff', 'Cleanup check': 'Clean' }
  const fileColor = (status: string) =>
    status === 'A' ? 'success' : status === 'D' ? 'error' : status === '??' ? undefined : 'warning'
  const heading = (title: string, color: 'claude' | 'error', note: string) => (
    <Text wrap="truncate-end">
      <Text bold color={color}>
        {title}
      </Text>
      <Text dimColor>{`  ${note}`}</Text>
    </Text>
  )

  const card = (one: Tracked) => {
    const path = one.path
    const snap = snaps[path]
    const agent = agents[path]
    const isActive = !!agent && ACTIVE.includes(agent.status)
    const isDim = one.isRemoved
    const isAgent = isAgentMade(one)
    const lineage = agent?.lineage ?? []
    const branch = snap?.branch ?? one.branch ?? nameOf(path)
    const files = snap?.files ?? []
    const diff = diffOf(snap)
    const bar = diff && barOf(diff.add, diff.del, scale, BAR_WIDTH)
    const spark = agent ? sparkOf(agent.samples) : ''
    const isMerged = !!snap && !snap.isGone && !!snap.base && snap.ahead === 0 && snap.dirty === 0
    const repo = repos.length > 1 && repoOf[path] ? `${nameOf(repoOf[path])} · ` : ''
    const isOpen = open.includes(one.toolUseId)

    return (
      <Box
        key={one.toolUseId}
        flexDirection="column"
        borderStyle="round"
        borderColor={one.isHere ? 'claude' : isActive ? 'success' : isAgent ? 'suggestion' : 'subtle'}
        borderDimColor={isDim}
        paddingX={1}
        marginLeft={isAgent ? 2 * Math.min(lineage.length, 4) : 0}
      >
        <Text wrap="truncate-end" bold={!isDim} dimColor={isDim}>
          {isAgent ? <Text color="suggestion">◆</Text> : '⎇'} {nameOf(path) || '(creating…)'}
          {one.isHere && <Text color="claude">{'  ★ here'}</Text>}
          {agent?.type && <Text color="suggestion">{`  [${agent.type}]`}</Text>}
          {one.isRunning && <Text dimColor>{'  running'}</Text>}
          {one.isRemoved && <Text dimColor>{'  removed'}</Text>}
        </Text>
        <Text wrap="truncate-end" color="suggestion" dimColor={isDim}>
          {madeBy(one)}
        </Text>
        {agent && lineage.length > 0 && (
          <Text wrap="truncate-end" dimColor>
            session ▸ {lineage.map(label => `"${label}" ▸ `).join('')}
            <Text color="suggestion">◆ "{agent.label}"</Text>
          </Text>
        )}
        {!snap && path !== '' && !one.isRemoved && <Text dimColor>scanning…</Text>}
        {snap?.isGone && <Text color="error">gone from disk</Text>}
        {snap && !snap.isGone && (
          <Text wrap="truncate-end">
            <Text dimColor>
              {repo}
              {branch}
            </Text>
            {snap.base && (
              <Text>
                {'  '}
                <Text color={snap.ahead ? 'success' : undefined} dimColor={!snap.ahead}>
                  ↑{snap.ahead}
                </Text>{' '}
                <Text color={snap.behind ? 'warning' : undefined} dimColor={!snap.behind}>
                  ↓{snap.behind}
                </Text>
                <Text dimColor> {snap.base}</Text>
              </Text>
            )}
            <Text dimColor> · </Text>
            {snap.dirty ? <Text color="warning">{snap.dirty} dirty</Text> : <Text color="success">clean</Text>}
            {isMerged && <Text dimColor> · nothing unmerged</Text>}
            {isNarrow && diff && (
              <Text>
                {' '}
                <Text color="success">+{diff.add}</Text> <Text color="error">−{diff.del}</Text>
              </Text>
            )}
          </Text>
        )}
        {!isNarrow && diff && bar && (
          <Text wrap="truncate-end">
            <Text color="success">{bar.green}</Text>
            <Text color="error">{bar.red}</Text>
            <Text dimColor>{bar.rest}</Text> <Text color="success">+{diff.add}</Text>{' '}
            <Text color="error">−{diff.del}</Text>
            <Text dimColor> · {diff.files} files</Text>
          </Text>
        )}
        {!isNarrow && snap?.lastSubject && (
          <Text wrap="truncate-end" dimColor>
            {snap.lastSubject} · {snap.lastAge}
          </Text>
        )}
        {agent && (
          <Text wrap="truncate-end" dimColor={!isActive}>
            <Text color={isActive ? 'success' : undefined}>●</Text> {agent.status}
            {agent.model ? ` · ${agent.model}` : ''} · {tokensOf(agent.tokenCount)} tok ·{' '}
            {Math.max(0, Math.round((now - agent.startTime) / 60000))}m
            {!isNarrow && spark && <Text color="claude"> {spark}</Text>}
          </Text>
        )}
        {(overlaps[path] ?? []).map(hit => (
          <Text wrap="truncate-end" color="warning">
            ⚠ overlaps {nameOf(hit.other)}: {hit.files.slice(0, 2).join(', ')}
            {hit.files.length > 2 ? ` (+${hit.files.length - 2})` : ''}
          </Text>
        ))}
        {isOpen &&
          files.slice(0, 20).map(file => (
            <Text wrap="truncate-end">
              {'  '}
              <Text color={fileColor(file.status)} dimColor={file.status === '??'}>
                {file.status.padEnd(2)}
              </Text>{' '}
              {file.path}
              {file.isUncommitted ? <Text dimColor> (uncommitted)</Text> : ''}
            </Text>
          ))}
        {isOpen && files.length > 20 && <Text dimColor> +{files.length - 20} more</Text>}
        {path && !snap?.isGone && !one.isRemoved && (
          <Box flexDirection="row" gap={1}>
            {Object.entries(prompts(path, branch, snap?.base)).map(([label, text]) => (
              <Button key={`${path}:${label}`} onPress={ask(text)}>
                {isNarrow ? (short[label] ?? label) : label}
              </Button>
            ))}
            {files.length > 0 && (
              <Button key={`${path}:files`} onPress={toggle(one.toolUseId)}>
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

  const problemLine = (problem: Problem) => {
    const who = problem.who === undefined ? 'this session' : `subagent «${problem.who}»`
    const lead = `✗ ${clockOf(problem.at)}  ${who}  ${problem.what}  `

    return (
      <Text wrap="truncate-end">
        <Text color="error">✗</Text>
        {` ${clockOf(problem.at)}  `}
        <Text color="suggestion">{who}</Text>
        {`  ${problem.what}  `}
        <Text color="error">{fit(problem.cause, Math.max(10, width - lead.length))}</Text>
      </Text>
    )
  }

  const facts = others.map(rowFacts)
  const tail = Math.max(
    0,
    ...others.map((row, i) => (facts[i] ?? '').length + (row.dirty ? ` · ${row.dirty} dirty`.length : 0)),
  )
  const longestName = Math.max(0, ...others.map(row => nameOf(row.path).length))
  const longestBranch = Math.max(0, ...others.map(row => (row.branch ?? 'detached').length))
  const room = width - 2 - 4 - tail
  const nameWidth = Math.min(longestName, Math.max(12, Math.ceil(room / 2)))
  const branchWidth = Math.min(longestBranch, room - nameWidth)
  const hasBranch = branchWidth >= 12
  const otherRow = (row: Row, i: number) => {
    const dot = row.isGone ? 'error' : row.dirty ? 'warning' : row.ahead === 0 ? 'success' : undefined

    return (
      <Text key={`row:${row.path}`} wrap="truncate-end">
        <Text color={dot} dimColor={dot === undefined}>
          ●
        </Text>
        {` ${fit(nameOf(row.path), hasBranch ? nameWidth : width - 6 - tail).padEnd(hasBranch ? nameWidth : 0)}  `}
        {hasBranch && <Text dimColor>{`${fit(row.branch ?? 'detached', branchWidth).padEnd(branchWidth)}  `}</Text>}
        <Text color={row.isGone ? 'error' : undefined} dimColor={!row.isGone}>
          {facts[i]}
        </Text>
        {!!row.dirty && (
          <Text>
            <Text dimColor> · </Text>
            <Text color="warning">{row.dirty} dirty</Text>
          </Text>
        )}
      </Text>
    )
  }
  const otherRepos = [...new Set(others.map(row => row.repo))]
  const otherLines = otherRepos.flatMap((repo, index) => {
    const rows = others.filter(row => row.repo === repo)
    const key = `repo:${repo}`
    const isFolding = otherRepos.length > 1
    const isShown = !isFolding || (index === 0) !== open.includes(key)
    const dirty = rows.filter(row => row.dirty).length
    const order = [...rows].sort((a, b) => Number(!!b.dirty) - Number(!!a.dirty))
    const header = isFolding ? (
      <Box key={key} flexDirection="row">
        <Text dimColor>{isShown ? '▾ ' : '▸ '}</Text>
        <Button key={key} onPress={toggle(key)}>
          {nameOf(repo)}
        </Button>
        <Text wrap="truncate-end">
          <Text dimColor>{`  ${count(rows.length, 'worktree', 'worktrees')}`}</Text>
          {dirty > 0 && <Text dimColor> · </Text>}
          {dirty > 0 && <Text color="warning">{dirty} dirty</Text>}
        </Text>
      </Box>
    ) : undefined

    return [...(header ? [header] : []), ...(isShown ? order.map(row => otherRow(row, others.indexOf(row))) : [])]
  })

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        {heading('THIS SESSION', 'claude', count(live.length, 'worktree', 'worktrees'))}
        <Button key="refresh" onPress={() => void refresh($, true)}>
          Refresh
        </Button>
      </Box>
      {list.length === 0 && <Text dimColor>No worktrees in this session yet.</Text>}
      {list.map(card)}
      {failed.length > 0 && <Text> </Text>}
      {failed.length > 0 &&
        heading(
          'PROBLEMS IN THIS SESSION',
          'error',
          count(failed.length, 'failed worktree call', 'failed worktree calls'),
        )}
      {failed.length > PROBLEMS_SHOWN && <Text dimColor>{`${failed.length - PROBLEMS_SHOWN} earlier`}</Text>}
      {failed.slice(-PROBLEMS_SHOWN).map(problemLine)}
      {others.length > 0 && <Text> </Text>}
      {others.length > 0 &&
        heading(
          'OTHER WORKTREES',
          'claude',
          `${others.length} in ${count(otherRepos.length, 'repository', 'repositories')}`,
        )}
      {otherLines}
    </Box>
  )
}

export async function drawBand($: EngineInterface, ui: ElementTable) {
  const list = liveTracked(await read($, tracked))
  const failed = await read($, problems)
  if (list.length === 0 && failed.length === 0) return undefined
  const { snaps, agents } = await read($, grove)
  const paths = list.map(one => one.path)
  const byAgents = list.filter(isAgentMade).length
  const overlaps = overlapsOf(snaps, paths)
  const { Box, Text, Button } = ui
  const tally = (n: number, word: string, color: 'warning' | 'success') => (
    <Text color={n > 0 ? color : undefined} dimColor={n === 0}>
      {n} {word}
    </Text>
  )

  return (
    <Box flexDirection="row" gap={1}>
      <Text wrap="truncate-end">
        <Text color="claude">⎇ {count(paths.length, 'worktree', 'worktrees')}</Text>
        {byAgents > 0 && <Text color="suggestion"> (◆ {byAgents} agent)</Text>}
        <Text dimColor> · </Text>
        {tally(paths.filter(path => (snaps[path]?.dirty ?? 0) > 0).length, 'dirty', 'warning')}
        <Text dimColor> · </Text>
        {tally(paths.filter(path => ACTIVE.includes(agents[path]?.status ?? '')).length, 'running', 'success')}
        <Text dimColor> · </Text>
        {tally(paths.filter(path => (overlaps[path]?.length ?? 0) > 0).length, 'overlap', 'warning')}
        {failed.length > 0 && <Text dimColor> · </Text>}
        {failed.length > 0 && <Text color="error">{count(failed.length, 'failed call', 'failed calls')}</Text>}
      </Text>
      <Button key="open" onPress={() => void openPane($)}>
        Open
      </Button>
    </Box>
  )
}
