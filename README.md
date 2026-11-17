# agent-worktree

A Claude Code mod that shows the git worktrees of the current session in a pane
beside the chat, as cards in the style of [forestui](https://github.com/flipbit03/forestui).

The mod is read-only. It never creates, switches, merges or removes a worktree.
Its buttons send investigate prompts to the running Claude session or open an
agent's transcript, and Claude does the work.

## What it shows

Open the pane with `/worktrees`. It also opens by itself when the session makes
its first worktree.

```
⎇ agent-1 agent "fix auth"
  worktree-agent-1 · ↑3 ↓0 vs main · 2 dirty · 5 files +120 −14
  last: Add login form · 12 minutes ago
  ● running opus 45k tok 3m
  ⚠ overlaps fix-auth: src/auth.ts, src/login.ts (+1)
  [ Investigate ] [ Review diff ] [ Cleanup check ] [ Files (5) ] [ View agent ]
```

- **This session**: worktrees made by the `EnterWorktree` tool and by agents
  started with `isolation: "worktree"`. The worktree the session is in is
  marked `★ here`; an agent still working is marked `running`.
- **Other Claude worktrees** (dimmed): every other worktree under
  `<repo>/.claude/worktrees/`, so leftovers from older sessions are visible.
- **Each card**: branch, commits ahead and behind the main worktree's branch,
  uncommitted file count, diff size, last commit and its age.
- **Live agent**: the agent working in the worktree, matched by its directory:
  status, model, tokens and minutes since it started. `View agent` opens its
  transcript. A background agent's card finds its worktree this way too.
- **Overlap warning**: files changed in two worktrees at once, the early sign
  of a merge conflict between parallel agents.
- **Clean badge**: `nothing unmerged · clean` when the branch has no commits
  beyond the base and no uncommitted files, a hint that it can be cleaned up.
- **File list**: `Files (n)` lists the changed files, uncommitted ones marked.
- **Band above the prompt**: `⎇ 3 worktrees · 1 dirty · 2 running · 1 overlap`
  with an `Open` button, while any worktree exists.
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
| `hooks/register.tsx` | The mod: tool-call tracking, git snapshots, pane, command |
| `hooks/register.test.tsx` | Tests |
| `types/index.d.ts` | The mod's `$.state` contract |

## Thanks

To [forestui](https://github.com/flipbit03/forestui) by
[@flipbit03](https://github.com/flipbit03): its worktree cards and Claude
session integration are the model for this mod. forestui is itself inspired by
[forest](https://github.com/ricwo/forest) by [@ricwo](https://github.com/ricwo).

## License

MIT, see [LICENSE](LICENSE).
