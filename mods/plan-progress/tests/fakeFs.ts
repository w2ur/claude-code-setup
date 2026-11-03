import type { On } from 'claude-code'

export type FakeFile = { text: string; mtimeMs: number; isLink?: boolean }

// Answers `fs.read` and `fs.list` from a map keyed by absolute path. The test
// kit's `mock` has no `fs`, and an unanswered event throws. A read of a missing
// path throws as the engine does (so does one in `failing`); a list answers the
// direct files of a directory and its direct subdirectories (kind 'dir'), and
// throws for a directory holding nothing, as a missing one does.
export function fakeFs(on: On, files: Map<string, FakeFile>, failing: Set<string> = new Set(), hold?: () => Promise<void>): { lists: () => string[]; reads: () => string[] } {
  const listed: string[] = []
  const read: string[] = []
  on('fs.read', (_, e) => {
    read.push(e.path)
    const file = files.get(e.path)
    if (file === undefined || failing.has(e.path)) throw new Error(`ENOENT: ${e.path}`)

    return { value: file.text }
  })
  on('fs.list', async (_, e) => {
    listed.push(e.path)
    if (hold !== undefined) await hold()
    if (failing.has(e.path)) throw new Error(`EIO: ${e.path}`)
    const prefix = e.path.endsWith('/') ? e.path : `${e.path}/`
    const entries = new Map<string, { name: string; kind: 'file' | 'dir'; isLink: boolean; size: number; mtimeMs: number }>()
    for (const [path, f] of files) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash === -1) entries.set(rest, { name: rest, kind: 'file', isLink: f.isLink === true, size: f.text.length, mtimeMs: f.isLink === true ? 0 : f.mtimeMs })
      else {
        const name = rest.slice(0, slash)
        if (!entries.has(name)) entries.set(name, { name, kind: 'dir', isLink: false, size: 0, mtimeMs: 0 })
      }
    }
    if (entries.size === 0) throw new Error(`ENOENT: ${e.path}`)

    return { value: [...entries.values()] }
  })

  return { lists: () => listed, reads: () => read }
}
