import type { On } from 'claude-code'

export type FakeFile = { text: string; mtimeMs: number }

// Answers `fs.write`, `fs.read` and `fs.list` from a map keyed by absolute path.
// The test kit's `mock` has no `fs`, and an unanswered event throws. A write
// stores the text and stamps it with `now()`; a read of a missing path throws
// as the engine does; a list answers the direct files of a directory.
export function fakeFs(on: On, files: Map<string, FakeFile>, now: () => number = () => 0, isHung: () => boolean = () => false): { writes: () => string[]; attempts: () => number } {
  const written: string[] = []
  let attempted = 0
  on('fs.write', async (_, e) => {
    attempted++
    // A write that never settles, as a stuck disk.
    if (isHung()) await new Promise<void>(() => {})
    files.set(e.path, { text: e.text, mtimeMs: now() })
    written.push(e.path)

    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const file = files.get(e.path)
    if (file === undefined) throw new Error(`ENOENT: ${e.path}`)

    return { value: file.text }
  })
  on('fs.list', (_, e) => {
    const prefix = e.path.endsWith('/') ? e.path : `${e.path}/`
    const entries = [...files]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(([path, f]) => ({ name: path.slice(prefix.length), kind: 'file' as const, isLink: false, size: f.text.length, mtimeMs: f.mtimeMs }))

    return { value: entries }
  })

  return { writes: () => written, attempts: () => attempted }
}
