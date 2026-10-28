import type { Register } from 'claude-code'

// The one switch of the right panel. A plugin cannot open another plugin's
// pane, so this mod only decides: each mod that joins hooks `command.run` on
// `panel`, awaits `next(e)` (this answer, at the bottom of the chain) and
// opens or closes its own pane on it. The engine draws one tab per pane.
//
// The chain runs in the order of CLAUDE_CODE_PLUGIN_DIRS, first listed
// outermost (measured 2026-10-28 on 2.1.312): this mod must be listed LAST,
// or it answers before the mods above it hear the command.
export const OPENED = 'Panel opened.'
export const CLOSED = 'Panel closed.'

// This session's panel. $.store is shared by every session, so it only seeds
// a new session (whose mods reopen the tabs they remember); after that a
// toggle in one session never flips another. A panel whose every tab the
// person closed by hand still reads open here: the next /panel closes
// nothing, and the one after reopens them.
let isOpen = false

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'panel', description: 'Toggle the right panel: every mod view as a tab' })
    isOpen = (await $.store.get('isOpen').catch(() => false)) === true

    return next(e)
  })

  on('command.run', { command: 'panel' }, async $ => {
    isOpen = !isOpen
    await $.store.set('isOpen', isOpen).catch(() => undefined)

    return { text: isOpen ? OPENED : CLOSED }
  })
}
