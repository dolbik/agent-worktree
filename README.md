<img src=".claude-plugin/icon.png" alt="" width="96" align="right">

# agent-worktree

```
/plugin install agent-worktree --marketplace vchaindz/agent-worktree
```

A Claude Code mod that shows the git worktrees of the current session in a pane
beside the chat, as cards in the style of [forestui](https://github.com/flipbit03/forestui).

The mod is read-only. It never creates, switches, merges or removes a worktree.
Its buttons send investigate prompts to the running Claude session or open an
agent's transcript, and Claude does the work.

## What it shows

Open the pane with `/worktrees`. It also opens by itself when the session makes
its first worktree.

```
THIS SESSION  2 worktrees                                        Refresh
╭──────────────────────────────────────────────────────────────╮
│ ◆ agent-1  [general-purpose]                                 │
│ made by subagent «fix auth» at 14:02 · background            │
│ worktree-agent-1  ↑3 ↓0 main · 2 dirty                       │
│ █████████████████████░ +120 −14 · 5 files                    │
│ Add login form · 12 minutes ago                              │
│ ● running · opus · 45k tok · 3m ▁▂▃▅▆▇█                      │
│ ⚠ overlaps side: src/auth.ts, src/login.ts (+1)              │
│ [ Investigate ] [ Review diff ] [ Cleanup check ] [ Files (5) ] [ View agent ] │
╰──────────────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────────╮
│ ⎇ side                                                       │
│ made by this session at 13:58 · git worktree add             │
│ side  ↑1 ↓0 main · clean                                     │
╰──────────────────────────────────────────────────────────────╯

PROBLEMS IN THIS SESSION  1 failed worktree call
✗ 14:05  subagent «fix auth»  add ../tmp-x  invalid reference: .

OTHER WORKTREES  3 in 1 repository
● fix-login        fix/login-timeout      ↑2 ↓0 · 4 days ago · 3 dirty
● docs-update      docs/install-steps     ↑1 ↓12 · 6 days ago
● old-spike        spike/cache            ↑1 ↓155 · 3 months ago
```

Each of this session's worktrees is a framed card: accent border for the one
the session is in, green while its agent runs, dim once removed. Numbers are
coloured (`↑` green, `↓` and `dirty` yellow, `+` green, `−` red), the bar shows
lines added and removed scaled across all cards, and the sparkline traces the
agent's token use over its last 16 readings. Below 60 columns a card drops the
bar, last commit and sparkline, and shortens its buttons.

- **This session**: every worktree the session or any of its subagents made,
  in any folder or repository: with the `EnterWorktree` tool, an agent started
  with `isolation: "worktree"`, or `git worktree add` run through Bash. A
  worktree made before the mod loaded is found by its lock, which names this
  session's process; one an agent works in is claimed for the session. Each
  card says who made it and when. A worktree stays here after its agent ends.
  The worktree the session is in is marked `★ here`.
- **Problems in this session**: one line per failed worktree call (a refused
  `EnterWorktree`, a `git worktree add` that failed), the last five.
- **Other worktrees**: the rest of the worktrees of the same repositories, one
  line each, folded by repository when there are several. Read once a minute
  and on `Refresh`.
- **Each card**: branch, commits ahead and behind the main worktree's branch,
  uncommitted file count, diff size, last commit and its age.
- **Live agent**: the agent working in the worktree, matched by its directory:
  status, model, tokens, minutes since it started and a token sparkline. `View agent` opens its
  transcript. A background agent's card finds its worktree this way too.
- **Overlap warning**: files changed in two worktrees at once, the early sign
  of a merge conflict between parallel agents.
- **Clean badge**: `clean · nothing unmerged` when the branch has no commits
  beyond the base and no uncommitted files, a hint that it can be cleaned up.
- **File list**: `Files (n)` lists the changed files, uncommitted ones marked.
- **Band above the prompt**: `⎇ 3 worktrees (◆ 1 agent) · 1 dirty · 2 running · 1 overlap · 1 failed call`
  with an `Open` button, while the session has a worktree or a failed call.
- **Done toast**: when a worktree agent finishes, for example
  `agent "fix auth" done: ↑3 · 5 files`.
- **Status line**: `⎇ <branch>` while the session is inside a worktree.

Everything refreshes every 5 s, and on `Refresh`.

## Buttons

Each button submits a prompt to the session. Every prompt ends with
"Read-only: do not modify, switch into, merge or remove the worktree."

| Button | Asks Claude to |
|---|---|
| Investigate | Summarize what was done in the worktree, how it stands against the base branch, and any uncommitted work |
| Review diff | Review `<base>...<branch>` for correctness bugs |
| Cleanup check | Report whether the worktree is merged, holds uncommitted files, or still has an agent working in it |

## Requirements

- Claude Code with function-hook mods (built against 2.1.326)
- `git` on `PATH`

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install agent-worktree --marketplace vchaindz/agent-worktree
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```bash
claude plugin install agent-worktree --marketplace vchaindz/agent-worktree
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace
with `vchaindz/agent-worktree`, then Add plugin.

To run a local checkout instead:

```bash
claude --plugin-dir /path/to/agent-worktree
```

## Development

`claude plugin validate .` reports what the engine will load and what it would
refuse; `claude plugin test .` runs `hooks/*.test.tsx` against the engine.

```bash
claude plugin validate .
claude plugin test .
```

Claude Code writes the API types to `.claude-plugin/types/` when it loads the
mod; `tsconfig.json` extends them, so `npx -p typescript tsc -p .` type-checks
the mod.

| Path | Holds |
|---|---|
| `.claude-plugin/plugin.json` | Manifest |
| `hooks/hooks.json` | Names the hooks module |
| `hooks/register.tsx` | The hooks: tool-call recording, command, drawing |
| `hooks/scan.ts` | Reading git and `$.agent.list()` every 5 s |
| `hooks/pane.tsx` | The pane and the band above the prompt |
| `hooks/detect.ts` | Reading `git worktree add` commands, worktree lists and locks |
| `hooks/*.test.ts(x)` | Tests |
| `types/index.d.ts` | The mod's `$.state` contract |

## Thanks

To [forestui](https://github.com/flipbit03/forestui) by
[@flipbit03](https://github.com/flipbit03): its worktree cards and Claude
session integration are the model for this mod. forestui is itself inspired by
[forest](https://github.com/ricwo/forest) by [@ricwo](https://github.com/ricwo).

## License

MIT, see [LICENSE](LICENSE).
