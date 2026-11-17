import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { branchesMade, firstLine, resolvePath, worktreeAdds } from './detect'
import { drawBand, drawPane, openPane } from './pane'
import {
  PANE,
  agentLabel,
  agentOf,
  complain,
  isGuess,
  labelOf,
  listAt,
  nameOf,
  noteBranches,
  refresh,
  remember,
  withoutGuesses,
} from './scan'

const tracked = atom({ plugin: 'agent-worktree', key: 'tracked' } as const, [], { shape: 'tracked-2' })

async function openOnFirst($: EngineInterface, wasEmpty: boolean) {
  if (wasEmpty && (await read($, tracked)).length > 0) void openPane($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'worktrees',
      description: "Show this session's git worktrees in a pane",
    })
    // the next run is set only when this one ends, so slow runs do not pile up
    const loop = (isFull: boolean): void =>
      void refresh($, isFull).finally(() => $.clock.after(5000, () => loop(false)))
    loop(true)

    return started
  })

  on('command.run', { command: 'worktrees' }, async $ => {
    await refresh($, true)
    await openPane($)

    return { text: 'Worktrees pane opened.' }
  })

  on('tool.call', { tool: 'EnterWorktree' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const isMain = e.agentId === undefined
    const label = await agentLabel($, e.agentId)
    const at = await $.clock.now()
    if (ran.isError) {
      await complain($, {
        at,
        who: label,
        what: `enter ${e.name ?? e.path ?? ''}`.trim(),
        cause: firstLine(ran.text ?? ''),
      })

      return ran
    }
    const { worktreePath: path, worktreeBranch: branch } = ran.result
    const wasEmpty = (await read($, tracked)).length === 0
    await update($, tracked, list => {
      const kept = list.find(one => one.path === path && !isGuess(one) && !one.isRemoved)

      return [
        ...list.filter(one => one.path !== path).map(one => (isMain ? { ...one, isHere: false } : one)),
        {
          ...(kept ?? {
            how: e.path ? ('entered' as const) : ('enter' as const),
            agentId: e.agentId,
            label,
            at,
            isRunning: false,
            isRemoved: false,
            toolUseId: e.tool_use_id,
          }),
          path,
          branch,
          isHere: isMain || (kept?.isHere ?? false),
          isRemoved: false,
        },
      ]
    })
    if (isMain) $.ui.status(`⎇ ${branch ?? nameOf(path)}`)
    await openOnFirst($, wasEmpty)

    return ran
  })

  on('tool.call', { tool: 'ExitWorktree' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const { worktreePath, action } = ran.result
    const isMain = e.agentId === undefined
    await update($, tracked, list =>
      list.map(one => ({
        ...one,
        isHere: isMain ? false : one.isHere,
        isRemoved: one.isRemoved || (action === 'remove' && one.path === worktreePath),
      })),
    )
    if (isMain) $.ui.status(undefined)

    return ran
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.isolation !== 'worktree') return next(e)
    const wasEmpty = (await read($, tracked)).length === 0
    await remember($, {
      path: '',
      how: 'agent',
      label: e.description,
      at: await $.clock.now(),
      isRunning: true,
      isHere: false,
      isRemoved: false,
      toolUseId: e.tool_use_id,
    })
    await openOnFirst($, wasEmpty)
    // a call that fails keeps a worktree the agent already made; an empty folder goes when it is deleted
    const ran = await next(e).catch(async error => {
      await update($, tracked, list =>
        list
          .filter(one => one.toolUseId !== e.tool_use_id || one.path !== '')
          .map(one => (one.toolUseId === e.tool_use_id ? { ...one, isRunning: false } : one)),
      )
      throw error
    })
    const result = (ran.result ?? {}) as {
      agentId?: string
      worktreePath?: string
      worktreeBranch?: string
      status?: string
    }
    if (ran.isError) {
      await complain($, {
        at: await $.clock.now(),
        who: await agentLabel($, e.agentId),
        what: `agent «${e.description}»`,
        cause: firstLine(ran.text ?? ''),
      })
    }
    // a finished agent with no worktreePath left nothing on disk
    const isEmpty = result.status === 'completed' && !result.worktreePath
    const isFailed = ran.deny !== undefined || ran.isError === true
    await update($, tracked, list =>
      withoutGuesses(
        list
          .filter(one => one.toolUseId !== e.tool_use_id || !(isEmpty || (isFailed && one.path === '')))
          .map(one =>
            one.toolUseId === e.tool_use_id
              ? {
                  ...one,
                  agentId: result.agentId ?? one.agentId,
                  isBackground: result.status === 'async_launched',
                  path: result.worktreePath ?? one.path,
                  branch: result.worktreeBranch ?? one.branch,
                  isRunning: false,
                }
              : one,
          ),
      ),
    )

    return ran
  })

  // a foreground agent's id is otherwise known only when its call returns
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const agentId = 'agentId' in spawned ? spawned.agentId : undefined
    if (agentId && (await read($, tracked)).some(one => one.toolUseId === e.tool_use_id && one.path === ''))
      await update($, tracked, list =>
        list.map(one => (one.toolUseId === e.tool_use_id && one.path === '' ? { ...one, agentId } : one)),
      )

    return spawned
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const adds = worktreeAdds(String(e.command ?? ''))
    const made = branchesMade(String(e.command ?? ''))
    if (adds.length === 0 && made.length === 0) return next(e)
    const home = (await $.env.get('HOME')) ?? ''
    const agent = await agentOf($, e.agentId)
    const here = e.agentId === undefined ? (await read($, tracked)).find(one => one.isHere)?.path : undefined
    const shell = agent?.cwd ?? here ?? (await $.session.cwd())
    const now = await $.clock.now()
    noteBranches(made.map(one => ({ dir: resolvePath(shell, one.dir ?? '.', home), branch: one.branch, at: now })))
    if (adds.length === 0) return next(e)
    const targets = adds.map(one => {
      const dir = resolvePath(shell, one.dir ?? '.', home)

      return { dir, name: one.path === null ? undefined : nameOf(resolvePath(dir, one.path, home)) }
    })
    const dirs = [...new Set(targets.map(one => one.dir))]
    const before = await Promise.all(dirs.map(dir => listAt($, dir)))
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const after = await Promise.all(dirs.map(dir => listAt($, dir)))
    // only the folders the command names, so worktrees others make meanwhile are not taken
    const added = after.flatMap((list, i) => {
      const was = before[i]
      const names = targets.filter(one => one.dir === dirs[i]).map(one => one.name)

      return (list ?? [])
        .slice(1)
        .filter(
          one =>
            !(was ?? []).some(old => old.path === one.path) &&
            names.some(name => (name === undefined ? was !== undefined : name === nameOf(one.path))),
        )
    })
    const label = agent ? labelOf(agent) : e.agentId
    const at = await $.clock.now()
    const wasEmpty = (await read($, tracked)).length === 0
    for (const one of added) {
      await remember($, {
        path: one.path,
        branch: one.branch,
        how: 'bash',
        agentId: e.agentId,
        label,
        at,
        isRunning: false,
        isHere: false,
        isRemoved: false,
        toolUseId: `${e.tool_use_id}:${one.path}`,
      })
    }
    if (added.length === 0 && ran.isError) {
      for (const one of adds) {
        await complain($, { at, who: label, what: `add ${one.path ?? ''}`.trim(), cause: firstLine(ran.text ?? '') })
      }
    }
    await openOnFirst($, wasEmpty)

    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) =>
    e.props.hasSurvey ? next(e) : ((await drawBand($, $.ui.resolve(e))) ?? next(e)),
  )

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => drawPane($, $.ui.resolve(e), e.props.bodyColumns))
}
