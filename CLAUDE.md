# agent-worktree

Claude Code mod (function-hook plugin): a pane listing the current session's git worktrees.

## Rules

- Read-only. The mod runs only read-only git commands (`worktree list`, `status`, `rev-list`,
  `diff --shortstat`, `diff --name-status`, `log`, `rev-parse`) and `$.agent.list()`. Never add a git mutation, tmux call, or worktree
  switch/remove. Actions are prompts sent with `$.prompt.submit` or `$.ui.view`; Claude does the work.
- Every prompt ends with the `READ_ONLY` sentence in `hooks/register.tsx`.
- State the pane draws lives in `$.state` atoms (`tracked`, `grove`, `expanded`), declared in
  `types/index.d.ts`. Change a stored value's fields, bump its `shape` tag.
- No DOM, no Node: reach the host through `$` (`$.process.run`, `$.fs`, `$.clock`).

## Layout

- `hooks/register.tsx`: `tool.call` hooks on `EnterWorktree`, `ExitWorktree`, `Agent`
  (`isolation: "worktree"`) track worktrees; `refresh` (every 5 s from `session.start`) reads git and `$.agent.list()`, fills background agents, toasts finished ones; `ui.render` on `Pane` draws cards, on `AbovePrompt` the summary band;
  `/worktrees` opens the pane.
- `hooks/register.test.tsx`: tests; each hook in a test stands for the engine.
- `.claude-plugin/types/`: written by Claude Code on load, not edited, not committed.

## Checks

Run all three before calling a change done:

```bash
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p .
```
