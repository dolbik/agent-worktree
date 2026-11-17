# agent-worktree

Claude Code mod (function-hook plugin): a pane listing the git worktrees the current session and its subagents made.

## Rules

- Read-only. The mod runs only read-only commands: git `worktree list`, `--no-optional-locks status`, `rev-list`,
  `diff --shortstat`, `diff --name-status`, `log`, `rev-parse`; `sh -c 'echo $PPID'` and `ps -o lstart= -p <pid>` to
  match a worktree's lock to this session's process; `gh api graphql` with a query, never a mutation, to read the PRs
  of this session's worktree branches; and `$.agent.list()`. It reads files
  only to find worktrees: the session's own transcript and its subagents' (`$.session.info().transcriptPath`). Never
  add a git mutation, tmux call, or worktree switch/remove. Actions are prompts sent with `$.prompt.submit` or
  `$.ui.view`; Claude does the work.
- Every prompt ends with the `READ_ONLY` sentence in `hooks/pane.tsx`.
- State the pane draws lives in `$.state` atoms (`tracked`, `grove`, `problems`, `expanded`, `pulls`), declared in
  `types/index.d.ts`. Each file that reads an atom declares it itself (the engine requires it); change a stored
  value's fields, bump its `shape` tag in every file.
- A function that takes `$` from another file is a `function` declaration, not an arrow (the engine requires it).
- No DOM, no Node: reach the host through `$` (`$.process.run`, `$.fs`, `$.clock`).

## Layout

- `hooks/register.tsx`: `tool.call` hooks record worktrees when they are made, in the main loop or a subagent's
  (`e.agentId`): `EnterWorktree`, `Agent` (`isolation: "worktree"`, its folder found by the `agentId` that
  `agent.spawn` gives the call), and Bash `git worktree add` (worktree list before and after the call); failed calls
  go to `problems`; `/worktrees` opens the pane.
- `hooks/scan.ts`: `refresh` (every 5 s from `session.start`) lists the worktrees of every repository the session
  touches, matches locks to this session's process, claims worktrees its agents work in (innermost folder wins),
  snapshots this session's worktrees, reads other worktrees once a minute, toasts finished agents. Once a minute,
  beside the refresh queue, it reads the PRs of the branches made in each of this session's worktrees with `gh`.
- `hooks/pane.tsx`: the pane (THIS SESSION cards, PROBLEMS IN THIS SESSION, OTHER WORKTREES rows) and the band.
- `hooks/detect.ts`: pure parsing: `git worktree add` in a Bash command, `worktree list --porcelain`, lock text,
  transcript lines.
- `hooks/history.ts`: on the first refresh, reads the session's and its subagents' transcripts (workflow agents' too)
  for worktrees and branches made before the plugin loaded; a Bash `git worktree add` counts only when the worktree's
  `.git` file was written then; `refresh` keeps worktrees that still exist.
- `hooks/*.test.ts(x)`: tests; each hook in a test stands for the engine.
- `.claude-plugin/types/`: written by Claude Code on load, not edited, not committed.

## Checks

Run all three before calling a change done:

```bash
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p .
```
