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

const isDynamic = (word: string) => /[$`]/.test(word)

const joinDir = (dir: string | null, path: string) =>
  dir === null || path.startsWith('/') ? path : `${dir.replace(/\/+$/, '')}/${path}`

export type WorktreeAdd = { dir: string | null; path: string | null }

// dir: where git runs (`-C`, else a leading `cd`), relative to the shell's folder; null when unknown
export const worktreeAdds = (command: string): WorktreeAdd[] => {
  const found: WorktreeAdd[] = []
  let cdDir: string | null | undefined = null
  for (const words of tokenize(withoutHeredocBodies(command))) {
    let i = 0
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? '')) i++
    const first = words[i] ?? ''
    if (first === 'cd') {
      const target = words[i + 1] ?? ''
      cdDir = cdDir === undefined || isDynamic(target) ? undefined : joinDir(cdDir, target)
      continue
    }
    if (first !== 'git' && !first.endsWith('/git')) continue
    let dir = cdDir
    for (i++; i < words.length && words[i] !== 'worktree'; i++) {
      const word = words[i] ?? ''
      if (word === '-C') {
        const target = words[++i] ?? ''
        dir = dir === undefined || isDynamic(target) ? undefined : joinDir(dir, target)
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
    found.push({ dir: dir ?? null, path: path !== undefined && !isDynamic(path) ? path : null })
  }

  return found
}
