// The Docs tab's state: the markdown files written this session, newest first;
// the one shown; a counter bumped whenever the shown file may have changed, so
// the pane redraws; the shown file's last seen modification time; and whether
// the person closed the tab (or the panel), which stops writes from reopening it.
export type Docs = { files: string[]; selected?: string; revision: number; seenMtime?: number; isMuted: boolean }

declare module 'claude-code' {
  interface PluginState {
    'doc-view': { docs: Shaped<Docs> }
  }
}
