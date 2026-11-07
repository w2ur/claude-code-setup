import type { Docs } from '../types'

export const MAX_FILES = 20
// The Markdown element draws at most 100,000 characters per drawing.
export const MAX_CHARS = 90_000
// $.fs.read rejects past 4 MiB.
export const MAX_BYTES = 4 * 1024 * 1024

export const EMPTY: Docs = { files: [], revision: 0, isMuted: false }

const MD = /\.(md|markdown|mdx)$/i
export const isMarkdown = (path: string): boolean => MD.test(path)

const front = (files: string[], path: string): string[] => [path, ...files.filter(f => f !== path)].slice(0, MAX_FILES)

// A file the main conversation wrote moves to the front and becomes the one shown.
export const remember = (docs: Docs, path: string): Docs =>
  ({ ...docs, files: front(docs.files, path), selected: path, revision: docs.revision + 1, seenMtime: undefined })

// A file a subagent wrote joins the list without taking the screen; the shown
// file still redraws if it was the one written.
export const remind = (docs: Docs, path: string): Docs =>
  ({ ...docs, files: front(docs.files, path), selected: docs.selected ?? path, revision: docs.revision + 1 })

export const select = (docs: Docs, path: string): Docs =>
  docs.files.includes(path) ? { ...docs, selected: path, seenMtime: undefined } : docs

export const baseName = (path: string): string => path.split('/').pop() ?? path

// The list label: the base name, or parent/base when another file shares it.
export function label(path: string, files: string[]): string {
  const base = baseName(path)
  if (files.filter(f => baseName(f) === base).length < 2) return base
  const parts = path.split('/')
  return parts.slice(-2).join('/')
}

// Home shortened to ~ so the path line fits.
export const shortPath = (path: string, home: string | undefined): string =>
  home !== undefined && home !== '' && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path

// What /docs <arg> names: full path, ~ path, list label or base name (newest wins).
export const find = (files: string[], arg: string, home: string | undefined): string | undefined =>
  files.find(f => f === arg || shortPath(f, home) === arg) ??
  files.find(f => label(f, files) === arg) ??
  files.find(f => baseName(f) === arg)

// The Markdown element refuses every control character but tab and newline;
// a CRLF file keeps its lines.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g
// A fence line opens or closes a code block.
const FENCE = /^\s*(```|~~~)/gm

export function clip(raw: string): string {
  const text = raw.replace(/\r\n?/g, '\n').replace(CONTROL, '')
  if (text.length <= MAX_CHARS) return text
  let head = text.slice(0, MAX_CHARS)
  if ((head.match(FENCE)?.length ?? 0) % 2 === 1) head += '\n```'
  return `${head}\n\n*… truncated: ${text.length - MAX_CHARS} more characters.*`
}

// Markdown paths a shell command names: quoted or bare, absolute, ~ or relative.
// Only candidates: the caller keeps those modified during the call.
export function mdPaths(command: string, home: string | undefined): string[] {
  const out = new Set<string>()
  for (const m of command.matchAll(/(["']?)([^\s"'<>|;&()`]+\.(?:md|markdown|mdx))\1(?![\w.])/gi)) {
    let p = m[2] ?? ''
    if (p.startsWith('~/') && home !== undefined) p = `${home}${p.slice(1)}`
    if (p !== '') out.add(p)
  }
  return [...out]
}
