import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface } from 'claude-code'

import type { AgentBadge, FileChange, Problem, Row, Snap, Tracked } from '../types'
import { deepest, isInside, parseLock, parseWorktreeList } from './detect'
import type { Listed } from './detect'

export const PANE = 'agent-worktree'
export const ACTIVE = ['pending', 'running', 'waiting']
export const ENDED = ['completed', 'failed', 'killed']
const ROWS_EVERY = 60_000

const tracked = atom({ plugin: 'agent-worktree', key: 'tracked' } as const, [], {
  shape: 'tracked-2',
})
const grove = atom(
  { plugin: 'agent-worktree', key: 'grove' } as const,
  { repoOf: {}, others: [], rowsAt: 0, snaps: {}, agents: {} },
  { shape: 'grove-5' },
)
const problems = atom({ plugin: 'agent-worktree', key: 'problems' } as const, [], {
  shape: 'problems-1',
})

export async function git($: EngineInterface, cwd: string, ...args: string[]) {
  try {
    const ran = await $.process.run(['git', ...args], { cwd })

    // trimEnd only: `status --porcelain` lines start with a meaningful space
    return ran.exitCode === 0 ? ran.stdout.trimEnd() : undefined
  } catch {
    return undefined
  }
}

const lines = (text?: string) => (text ? text.split('\n') : [])
export const nameOf = (path: string) => path.split('/').pop() || path

export const liveTracked = (list: Tracked[]) => list.filter(one => one.path && !one.isRemoved)
export const labelOf = (agent: AgentInfo) => agent.description || agent.label

export async function listAt($: EngineInterface, dir: string) {
  const porcelain = await git($, dir, 'worktree', 'list', '--porcelain')

  return porcelain === undefined ? undefined : parseWorktreeList(porcelain)
}

function status($: EngineInterface, path: string) {
  return git($, path, '--no-optional-locks', 'status', '--porcelain')
}

async function countsOf($: EngineInterface, path: string, base?: string) {
  const counts = base ? await git($, path, 'rev-list', '--left-right', '--count', `${base}...HEAD`) : undefined
  const [behind = 0, ahead = 0] = (counts ?? '').trim().split(/\s+/).map(Number)

  return { ahead: ahead || 0, behind: behind || 0 }
}

async function snapOf($: EngineInterface, path: string, base?: string): Promise<Snap> {
  if (!(await $.fs.exists(path))) return { isGone: true, ahead: 0, behind: 0, dirty: 0, files: [] }

  const [branch, changes, counts, shortstat, nameStatus, last] = await Promise.all([
    git($, path, 'rev-parse', '--abbrev-ref', 'HEAD'),
    status($, path),
    countsOf($, path, base),
    base ? git($, path, 'diff', '--shortstat', `${base}...HEAD`) : undefined,
    base ? git($, path, 'diff', '--name-status', `${base}...HEAD`) : undefined,
    git($, path, 'log', '-1', '--format=%s%x00%cr'),
  ])
  const [lastSubject, lastAge] = (last ?? '').split('\0')
  const committed: FileChange[] = lines(nameStatus).map(line => {
    const parts = line.split('\t')

    return { status: parts[0]?.[0] ?? '?', path: parts[parts.length - 1] ?? '', isUncommitted: false }
  })
  const seen = new Set(committed.map(file => file.path))
  const uncommitted: FileChange[] = lines(changes)
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
    ...counts,
    dirty: lines(changes).length,
    shortstat: shortstat?.trim() || undefined,
    lastSubject: lastSubject || undefined,
    lastAge,
    files: [...committed, ...uncommitted],
  }
}

async function rowOf($: EngineInterface, one: Listed & { repo: string }, base?: string): Promise<Row> {
  if (!(await $.fs.exists(one.path))) return { path: one.path, repo: one.repo, branch: one.branch, isGone: true }
  const [changes, counts, age] = await Promise.all([
    status($, one.path),
    countsOf($, one.path, base),
    git($, one.path, 'log', '-1', '--format=%cr'),
  ])

  return {
    path: one.path,
    repo: one.repo,
    branch: one.branch,
    isGone: false,
    ...counts,
    dirty: lines(changes).length,
    age,
  }
}

let own: { pid: number; startedAt: string } | undefined

// Claude Code locks a worktree it makes with `claude session <name> (pid <its pid> start <its start, UTC>)`
async function ownProcess($: EngineInterface) {
  try {
    const sh = await $.process.run(['sh', '-c', 'echo $PPID'])
    const pid = Number.parseInt(sh.stdout.trim(), 10)
    if (sh.exitCode !== 0 || !Number.isInteger(pid)) return undefined
    const ps = await $.process.run(['ps', '-o', 'lstart=', '-p', String(pid)], { env: { TZ: 'UTC', LC_ALL: 'C' } })
    const startedAt = ps.stdout.trim()

    return ps.exitCode === 0 && startedAt !== '' ? { pid, startedAt } : undefined
  } catch {
    return undefined
  }
}

const sameText = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()

const lineageOf = (agent: AgentInfo, agents: AgentInfo[]) => {
  const chain: string[] = []
  // the cap guards against a parentId cycle
  for (let up = agents.find(one => one.id === agent.parentId); up && chain.length < 8; ) {
    chain.unshift(labelOf(up))
    const parentId = up.parentId
    up = agents.find(one => one.id === parentId)
  }

  return chain
}

const badgeOf = (agent: AgentInfo, agents: AgentInfo[]): AgentBadge => ({
  id: agent.id,
  label: labelOf(agent),
  type: agent.type,
  lineage: lineageOf(agent, agents),
  status: agent.status,
  model: agent.model,
  tokenCount: agent.tokenCount,
  samples: agent.tokenSamples,
  startTime: agent.startTime,
})

export const isGuess = (one: Tracked) => one.toolUseId.startsWith('seen:') || one.toolUseId.startsWith('lock:')

// what a tool call recorded wins over what a refresh guessed for the same folder
export const withoutGuesses = (list: Tracked[]) => {
  const known = new Set(list.filter(one => one.path && !isGuess(one)).map(one => one.path))

  return list.filter(one => !isGuess(one) || !known.has(one.path))
}

export function remember($: EngineInterface, entry: Tracked) {
  return update($, tracked, list =>
    entry.path !== '' && list.some(one => one.path === entry.path && !isGuess(one) && !one.isRemoved)
      ? list
      : withoutGuesses([...list.filter(one => one.path !== entry.path || !one.isRemoved), entry]),
  )
}

export function complain($: EngineInterface, problem: Problem) {
  return update($, problems, list => [...list, problem].slice(-50))
}

export async function agentOf($: EngineInterface, agentId?: string) {
  return agentId === undefined ? undefined : (await $.agent.list()).find(one => one.id === agentId)
}

export async function agentLabel($: EngineInterface, agentId?: string) {
  const agent = await agentOf($, agentId)

  return agent ? labelOf(agent) : agentId
}

let queue: Promise<void> = Promise.resolve()

// one run at a time, so two runs never both see an agent finish and both toast
export function refresh($: EngineInterface, isFull = false) {
  queue = queue.catch(() => undefined).then(() => refreshNow($, isFull))

  return queue
}

async function refreshNow($: EngineInterface, isFull: boolean) {
  const now = await $.clock.now()
  const before = await read($, tracked)
  const sessionDir = before.find(one => one.isHere)?.path ?? (await $.session.cwd())
  const agents = await $.agent.list()

  const lists = new Map<string, Listed[]>()
  const seeds = [
    sessionDir,
    ...liveTracked(before).map(one => one.path),
    ...agents.filter(one => ACTIVE.includes(one.status)).map(one => one.cwd),
  ]
  for (const seed of seeds) {
    if ([...lists.values()].some(list => list.some(one => isInside(seed, one.path)))) continue
    const list = await listAt($, seed)
    if (list?.[0]) lists.set(list[0].path, list)
  }
  const bases: Record<string, string | undefined> = {}
  const listed: (Listed & { repo: string })[] = []
  for (const [repo, list] of lists) {
    bases[repo] = list[0]?.branch
    listed.push(...list.slice(1).map(one => ({ ...one, repo })))
  }
  const paths = listed.map(one => one.path)
  const repoOf: Record<string, string> = Object.fromEntries(listed.map(one => [one.path, one.repo]))
  const branchOf = (path: string) => listed.find(one => one.path === path)?.branch
  // an agent without its own folder runs in the session's, which is no worktree of its own
  const agentFolder = (agent: AgentInfo) => {
    const path = deepest(agent.cwd, paths)

    return path && !isInside(sessionDir, path) ? path : undefined
  }
  const folderOf = (agentId: string) => {
    const agent = agents.find(one => one.id === agentId)

    return paths.find(path => nameOf(path) === `agent-${agentId}`) ?? (agent && agentFolder(agent))
  }

  const fills: Record<string, string> = {}
  const drops = new Set<string>()
  for (const one of before.filter(entry => entry.path === '' && entry.agentId)) {
    const agentId = one.agentId as string
    const path = folderOf(agentId)
    if (path) fills[one.toolUseId] = path
    else if (!one.isRunning && !ACTIVE.includes(agents.find(agent => agent.id === agentId)?.status ?? ''))
      drops.add(one.toolUseId)
  }

  const mine = new Set([...before.map(one => one.path), ...Object.values(fills)])
  const adds: Tracked[] = []
  const add = (entry: Omit<Tracked, 'isRunning' | 'isHere' | 'isRemoved'>) => {
    adds.push({ ...entry, isRunning: false, isHere: false, isRemoved: false })
    mine.add(entry.path)
  }
  const lockedHere = listed.filter(one => !mine.has(one.path) && one.lock && parseLock(one.lock))
  if (lockedHere.length > 0) own ??= await ownProcess($)
  for (const one of lockedHere) {
    const lock = parseLock(one.lock as string)
    if (!own || lock?.pid !== own.pid || !sameText(lock.startedAt, own.startedAt)) continue
    const agentId = /^agent-(.+)$/.exec(nameOf(one.path))?.[1]
    const agent = agents.find(entry => entry.id === agentId)
    add({
      path: one.path,
      branch: one.branch,
      how: 'lock',
      agentId,
      label: agent && labelOf(agent),
      toolUseId: `lock:${one.path}`,
    })
  }
  for (const agent of agents) {
    const path = agentFolder(agent)
    if (!path || mine.has(path)) continue
    add({
      path,
      branch: branchOf(path),
      how: 'agent',
      agentId: agent.id,
      label: labelOf(agent),
      at: agent.startTime,
      toolUseId: `seen:${path}`,
    })
  }
  if (Object.keys(fills).length > 0 || drops.size > 0 || adds.length > 0) {
    await update($, tracked, list =>
      withoutGuesses([
        ...list
          .filter(one => !drops.has(one.toolUseId))
          .map(one => {
            const path = fills[one.toolUseId]

            return path ? { ...one, path, branch: branchOf(path) ?? one.branch } : one
          }),
        ...adds.filter(entry => !list.some(one => one.path === entry.path)),
      ]),
    )
  }

  const live = liveTracked(await read($, tracked))
  const snaps = Object.fromEntries(
    await Promise.all(
      live.map(async one => [one.path, await snapOf($, one.path, bases[repoOf[one.path] ?? ''])] as const),
    ),
  )
  // Claude Code deletes an agent's worktree when the agent ends with no changes
  const isDeleted = (one: Tracked) =>
    one.how === 'agent' &&
    !!snaps[one.path]?.isGone &&
    !ACTIVE.includes(agents.find(agent => agent.id === one.agentId)?.status ?? '')
  const deleted = new Set(live.filter(isDeleted).map(one => one.toolUseId))
  if (deleted.size > 0) await update($, tracked, list => list.filter(one => !deleted.has(one.toolUseId)))
  const ownPaths = live.filter(one => !deleted.has(one.toolUseId)).map(one => one.path)
  const badgePaths = [...new Set([...paths, ...ownPaths])]
  const badges: Record<string, AgentBadge> = {}
  for (const agent of [...agents].sort((a, b) => a.startTime - b.startTime)) {
    const path = deepest(agent.cwd, badgePaths)
    if (path && ownPaths.includes(path)) badges[path] = badgeOf(agent, agents)
  }

  const previous = await read($, grove)
  for (const [path, badge] of Object.entries(badges)) {
    const was = previous.agents[path]
    if (was?.id !== badge.id || !ACTIVE.includes(was.status) || !ENDED.includes(badge.status)) continue
    const snap = snaps[path]
    const word = badge.status === 'completed' ? 'done' : badge.status
    $.ui.toast(`agent "${badge.label}" ${word}: ↑${snap?.ahead ?? 0} · ${snap?.files.length ?? 0} files`)
  }

  const repoOfDir = (dir: string) => [...lists].find(([, entries]) => entries.some(one => isInside(dir, one.path)))?.[0]
  const shown = new Set([repoOfDir(sessionDir), ...ownPaths.map(path => repoOf[path])])
  const others = listed.filter(one => shown.has(one.repo) && !ownPaths.includes(one.path))
  const isStale = isFull || now - previous.rowsAt >= ROWS_EVERY
  const cached = new Map(previous.others.map(row => [row.path, row]))
  const rows = await Promise.all(
    others.map(async one => {
      const row = cached.get(one.path)

      return !isStale && row ? { ...row, branch: one.branch } : rowOf($, one, bases[one.repo])
    }),
  )

  await update($, grove, () => ({
    repoOf,
    others: rows,
    rowsAt: isStale ? now : previous.rowsAt,
    snaps,
    agents: badges,
  }))
}
