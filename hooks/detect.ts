import type { Tracked } from '../types'

export type Listed = { path: string; branch?: string; lock?: string }

export const parseWorktreeList = (porcelain: string): Listed[] =>
  porcelain
    .split('\n\n')
    .filter(block => block.trim() !== '')
    .map(block => {
      const locked = block.match(/^locked(?: (.*))?$/m)

      return {
        path: block.match(/^worktree (.*)$/m)?.[1] ?? '',
        branch: block.match(/^branch refs\/heads\/(.*)$/m)?.[1],
        lock: locked ? (locked[1] ?? '') : undefined,
      }
    })

export const parseLock = (text: string) => {
  const found = /^claude session .* \(pid (\d+) start ([^)]+)\)$/.exec(text.trim())

  return found ? { pid: Number(found[1]), startedAt: (found[2] ?? '').trim() } : null
}

export const isInside = (dir: string, path: string) => dir === path || dir.startsWith(`${path}/`)

export const deepest = (dir: string, paths: string[]) =>
  paths.filter(path => isInside(dir, path)).sort((a, b) => b.length - a.length)[0]

export const resolvePath = (folder: string, path: string, home: string) => {
  const full =
    path === '~' || path.startsWith('~/') ? home + path.slice(1) : path.startsWith('/') ? path : `${folder}/${path}`
  const parts: string[] = []
  for (const part of full.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '' && part !== '.') parts.push(part)
  }

  return `/${parts.join('/')}`
}

export const firstLine = (text: string) => {
  const found = text
    .replace(/<\/?tool_use_error>/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !/^Exit code \d+$/.test(line))
  const line = found.find(one => /^(fatal|error): /.test(one)) ?? found[0] ?? ''

  return line.replace(/^(fatal|error): /, '').slice(0, 200)
}

// a heredoc's lines are input to the command, not commands
const withoutHeredocBodies = (command: string) => {
  const out: string[] = []
  const ends: string[] = []
  for (const line of command.split('\n')) {
    if (ends.length > 0) {
      if (line.replace(/^\t+/, '') === ends[0]) ends.shift()
      continue
    }
    out.push(line)
    for (const found of line.matchAll(/(?<!<)<<-?(?!<)\s*(['"]?)([A-Za-z0-9_]+)\1/g)) ends.push(found[2] as string)
  }

  return out.join('\n')
}

const tokenize = (command: string) => {
  const segments: string[][] = [[]]
  let word = ''
  let isStarted = false
  let quote: '"' | "'" | null = null
  const flush = () => {
    if (isStarted) segments[segments.length - 1]?.push(word)
    word = ''
    isStarted = false
  }
  for (let i = 0; i < command.length; i++) {
    const c = command.charAt(i)
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command.charAt(++i).replace('\n', '')
      else word += c
    } else if (c === '"' || c === "'") {
      quote = c
      isStarted = true
    } else if (c === '\\' && command.charAt(i + 1) === '\n') {
      i++
    } else if (c === '\\' && i + 1 < command.length) {
      word += command.charAt(++i)
      isStarted = true
    } else if (c === '\n' || c === ';' || c === '&' || c === '|') {
      flush()
      segments.push([])
    } else if (/\s/.test(c)) {
      flush()
    } else {
      word += c
      isStarted = true
    }
  }
  flush()

  return segments
}

const isDynamic = (word: string) => /[$`]/.test(word) || word === '-'

// undefined: a folder the command names through a variable, which cannot be known
const joinDir = (dir: string | null | undefined, path: string) =>
  isDynamic(path)
    ? undefined
    : /^[/~]/.test(path) || dir === null
      ? path
      : dir === undefined
        ? undefined
        : `${dir.replace(/\/+$/, '')}/${path}`

export type WorktreeAdd = { dir: string | null; path: string | null }

// dir: where git runs (`-C`, else a leading `cd`), relative to the shell's folder, null for that folder itself
export const worktreeAdds = (command: string): WorktreeAdd[] => {
  const found: WorktreeAdd[] = []
  let cdDir: string | null | undefined = null
  for (const words of tokenize(withoutHeredocBodies(command))) {
    let i = 0
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? '')) i++
    const first = words[i] ?? ''
    if (first === 'cd') {
      cdDir = joinDir(cdDir, words[i + 1] ?? '~')
      continue
    }
    if (first !== 'git' && !first.endsWith('/git')) continue
    let dir = cdDir
    for (i++; i < words.length && words[i] !== 'worktree'; i++) {
      const word = words[i] ?? ''
      if (word === '-C') {
        dir = joinDir(dir, words[++i] ?? '')
      } else if (word === '-c') i++
      else if (!word.startsWith('-')) break
    }
    if (words[i] !== 'worktree' || words[i + 1] !== 'add') continue
    let path: string | undefined
    for (i += 2; i < words.length; i++) {
      const word = words[i] ?? ''
      if (word === '-b' || word === '-B' || word === '--reason') i++
      else if (word === '--') path ??= words[++i]
      else if (!word.startsWith('-')) path ??= word
    }
    if (dir !== undefined) found.push({ dir, path: path !== undefined && !isDynamic(path) ? path : null })
  }

  return found
}

// a range of text read from a file: the whole lines in it and their size in bytes
export const wholeLines = (text: string, isLast: boolean) => {
  const end = isLast ? text.length : text.lastIndexOf('\n') + 1
  const whole = text.slice(0, end)

  return { lines: whole.split('\n').filter(line => line !== ''), bytes: utf8Length(whole) }
}

export const utf8Length = (text: string) =>
  text.length +
  (text.match(/[\u0080-\u07ff]/g)?.length ?? 0) +
  2 * (text.match(/[\u0800-\ud7ff\ue000-\uffff]/g)?.length ?? 0) +
  (text.match(/[\ud800-\udfff]/g)?.length ?? 0)

export type Found = Pick<Tracked, 'path' | 'how' | 'agentId' | 'label' | 'at' | 'isBackground'>

type Block = { type?: string; name?: string; input?: { command?: unknown } }
type Line = {
  cwd?: string
  timestamp?: string
  message?: { content?: unknown }
  toolUseResult?: { worktreePath?: string; message?: string }
}

const lineOf = (text: string): Line | undefined => {
  try {
    return JSON.parse(text) as Line
  } catch {
    return undefined
  }
}

// only lines that can hold an EnterWorktree result or a Bash `git worktree add` are parsed
export const isMadeLine = (text: string) =>
  text.includes('"toolUseResult":{"worktreePath"') || (text.includes('worktree add') && text.includes('"name":"Bash"'))

// worktrees a transcript's lines show being made or entered; a Bash path resolves against the line's cwd
export const madeIn = (texts: string[], home: string, who: Pick<Found, 'agentId' | 'label'> = {}): Found[] =>
  texts.flatMap((text): Found[] => {
    const line = lineOf(text)
    const at = line?.timestamp ? Date.parse(line.timestamp) : undefined
    const result = line?.toolUseResult
    const kind = /^(Created|Entered|Resumed) worktree/.exec(result?.message ?? '')?.[1]
    if (result?.worktreePath && kind)
      return [
        { path: result.worktreePath, how: kind === 'Created' ? ('enter' as const) : ('entered' as const), at, ...who },
      ]
    const content = line?.message?.content
    const cwd = line?.cwd
    if (!Array.isArray(content) || !cwd) return []

    return (content as Block[])
      .filter(block => block.type === 'tool_use' && block.name === 'Bash')
      .flatMap(block => worktreeAdds(String(block.input?.command ?? '')))
      .flatMap(add =>
        add.path === null
          ? []
          : [
              {
                path: resolvePath(resolvePath(cwd, add.dir ?? '.', home), add.path, home),
                how: 'bash' as const,
                at,
                ...who,
              },
            ],
      )
  })
