import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { firstLine, resolvePath, worktreeAdds } from './detect'
import { drawBand, drawPane, openPane } from './pane'
import { PANE, agentLabel, complain, listAt, refresh, remember, withoutGuesses } from './scan'

const tracked = atom({ plugin: 'agent-worktree', key: 'tracked' } as const, [], { shape: 'tracked-2' })

async function loopDir($: EngineInterface, agentId?: string) {
  return (
    (agentId === undefined ? undefined : (await $.agent.list()).find(one => one.id === agentId)?.cwd) ??
    (await $.session.cwd())
  )
}

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
    void refresh($, true)
    $.clock.every(5000, () => void refresh($))

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
    await update($, tracked, list => [
      ...list.filter(one => one.path !== path).map(one => (isMain ? { ...one, isHere: false } : one)),
      {
        ...(list.find(one => one.path === path) ?? {
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
        isHere: isMain,
      },
    ])
    if (isMain) $.ui.status(`⎇ ${branch ?? path.split('/').pop()}`)
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
    const ran = await next(e)
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
    const isGone =
      ran.deny !== undefined || ran.isError === true || (result.status === 'completed' && !result.worktreePath)
    await update($, tracked, list =>
      withoutGuesses(
        list
          .filter(one => one.toolUseId !== e.tool_use_id || !isGone)
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

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const adds = worktreeAdds(String(e.command ?? ''))
    if (adds.length === 0) return next(e)
    const home = (await $.env.get('HOME')) ?? ''
    const shell = await loopDir($, e.agentId)
    const dirs = [...new Set(adds.map(one => resolvePath(shell, one.dir ?? '.', home)))]
    const before = await Promise.all(dirs.map(dir => listAt($, dir)))
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const after = await Promise.all(dirs.map(dir => listAt($, dir)))
    const added = after.flatMap((list, i) =>
      (list ?? []).slice(1).filter(one => !(before[i] ?? []).some(was => was.path === one.path)),
    )
    const label = await agentLabel($, e.agentId)
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
