import type { EngineInterface } from 'claude-code'

import { branchesIn, jsonOf, keptLines, madeIn, timeOf, wholeLines } from './detect'
import type { Found, Kept, Made } from './detect'

// under the 4 MiB read cap, with room for a character cut at either edge
const RANGE = 4 * 1024 * 1024 - 64

// a line longer than one range is skipped
async function madeLines($: EngineInterface, path: string) {
  const { size } = await $.fs.stat(path)
  const lines: Kept[] = []
  let shell: string | undefined
  for (let offset = 0; offset < size; ) {
    const isLast = offset + RANGE >= size
    const range = wholeLines(await $.fs.read(path, { offset, length: RANGE }), isLast)
    const next = keptLines(range.lines, shell)
    lines.push(...next.kept)
    shell = next.shell
    offset += isLast ? RANGE : range.bytes || RANGE
  }

  return lines
}

// subagents' transcripts, and those of the agents their workflows ran
async function transcriptsIn($: EngineInterface, folder: string, depth = 2): Promise<string[]> {
  const entries = await $.fs.list(folder).catch(() => [])
  const files = entries
    .filter(entry => entry.kind === 'file' && /^agent-.+\.jsonl$/.test(entry.name))
    .map(entry => `${folder}/${entry.name}`)
  const dirs = depth > 0 ? entries.filter(entry => entry.kind === 'dir') : []
  const nested = await Promise.all(dirs.map(entry => transcriptsIn($, `${folder}/${entry.name}`, depth - 1)))

  return [...files, ...nested.flat()]
}

// a worktree whose .git file is older than the Bash add was there already, so that add failed
async function isMadeThen($: EngineInterface, one: Found) {
  if (one.how !== 'bash') return true
  const stat = await $.fs.stat(`${one.path}/.git`).catch(() => undefined)

  return !!stat && one.at !== undefined && stat.mtimeMs >= one.at - 60_000
}

async function madeInFile($: EngineInterface, file: string, home: string, isMain: boolean) {
  const lines = await madeLines($, file)
  const agentId = isMain ? undefined : /agent-([^/]+)\.jsonl$/.exec(file)?.[1]
  if (!agentId) return { worktrees: madeIn(lines, home), branches: branchesIn(lines, home) }
  const meta = jsonOf<Record<string, unknown>>(await $.fs.read(file.replace(/\.jsonl$/, '.meta.json')).catch(() => ''))
  const who = { agentId, label: typeof meta?.description === 'string' ? meta.description : agentId }
  const worktrees = madeIn(lines, home, who)
  const first = jsonOf<Record<string, unknown>>((await $.fs.read(file, { length: 1024 * 1024 })).split('\n')[0] ?? '')
  // an agent started with isolation runs in a worktree named after it
  if (typeof first?.cwd === 'string' && first.cwd.endsWith(`/agent-${agentId}`))
    worktrees.push({
      path: first.cwd,
      how: 'agent',
      ...who,
      at: timeOf(first.timestamp),
      isBackground: meta?.requestShape === 'background',
    })

  return { worktrees, branches: branchesIn(lines, home) }
}

// worktrees and branches the session and its subagents made before the plugin loaded, from their transcripts
export async function madeBefore($: EngineInterface): Promise<{ worktrees: Found[]; branches: Made[] }> {
  const { transcriptPath } = await $.session.info()
  const home = (await $.env.get('HOME')) ?? ''
  const files = [transcriptPath, ...(await transcriptsIn($, `${transcriptPath.replace(/\.jsonl$/, '')}/subagents`))]
  const read = []
  for (const file of files) read.push(await madeInFile($, file, home, file === transcriptPath).catch(() => undefined))
  const worktrees = read.flatMap(one => one?.worktrees ?? [])
  const kept = await Promise.all(worktrees.map(async one => ((await isMadeThen($, one)) ? [one] : [])))

  return {
    worktrees: kept.flat().sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
    branches: read.flatMap(one => one?.branches ?? []),
  }
}
