export type Tracked = {
  path: string
  branch?: string
  source: 'enter' | 'agent'
  label?: string
  isRunning: boolean
  isHere: boolean
  isRemoved: boolean
  toolUseId: string
}

export type FileChange = { status: string; path: string; isUncommitted: boolean }

export type Snap = {
  isGone: boolean
  branch?: string
  base?: string
  ahead: number
  behind: number
  dirty: number
  shortstat?: string
  lastSubject?: string
  lastAge?: string
  files: FileChange[]
}

export type AgentBadge = {
  id: string
  label: string
  status: string
  model?: string
  tokenCount: number
  startTime: number
}

export type Grove = {
  repo?: string
  base?: string
  others: string[]
  snaps: Record<string, Snap>
  agents: Record<string, AgentBadge>
}

declare module 'claude-code' {
  interface PluginState {
    'agent-worktree': {
      tracked: Shaped<Tracked[]>
      grove: Shaped<Grove>
      expanded: Shaped<string[]>
    }
  }
}
