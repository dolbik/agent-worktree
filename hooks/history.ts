import type { EngineInterface } from 'claude-code'

import { isMadeLine, madeIn, wholeLines } from './detect'
import type { Found } from './detect'

const RANGE = 4 * 1024 * 1024

const parse = (text: string) => {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return undefined
  }
}

// a line longer than one range is skipped
async function madeLines($: EngineInterface, path: string) {
  const { size } = await $.fs.stat(path)
  const lines: string[] = []
  for (let offset = 0; offset < size; ) {
    const isLast = offset + RANGE >= size
    const range = wholeLines(await $.fs.read(path, { offset, length: RANGE }), isLast)
    lines.push(...range.lines.filter(isMadeLine))
    offset += isLast ? RANGE : range.bytes || RANGE
  }

  return lines
}

// worktrees the session and its subagents made or entered before the plugin loaded, from their transcripts
export async function madeBefore($: EngineInterface): Promise<Found[]> {
  const { transcriptPath } = await $.session.info()
  const home = (await $.env.get('HOME')) ?? ''
  const found = madeIn(await madeLines($, transcriptPath), home)
  const folder = `${transcriptPath.replace(/\.jsonl$/, '')}/subagents`
  const entries = (await $.fs.exists(folder)) ? await $.fs.list(folder) : []
  for (const entry of entries) {
    const agentId = /^agent-(.+)\.jsonl$/.exec(entry.name)?.[1]
    if (!agentId) continue
    const file = `${folder}/${entry.name}`
    const meta = parse(await $.fs.read(`${folder}/agent-${agentId}.meta.json`).catch(() => ''))
    const who = { agentId, label: typeof meta?.description === 'string' ? meta.description : agentId }
    const first = parse((await $.fs.read(file, { length: 1024 * 1024 })).split('\n')[0] ?? '')
    // an agent started with isolation runs in a worktree named after it
    if (typeof first?.cwd === 'string' && first.cwd.endsWith(`/agent-${agentId}`))
      found.push({
        path: first.cwd,
        how: 'agent',
        ...who,
        at: typeof first.timestamp === 'string' ? Date.parse(first.timestamp) : undefined,
        isBackground: meta?.requestShape === 'background',
      })
    found.push(...madeIn(await madeLines($, file), home, who))
  }

  return found.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
}
