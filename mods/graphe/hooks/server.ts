// The corpus server, one child process per opening of the pane: My Editor App's
// `tools/index/serve.ts`, which answers over HTTP on a Unix socket of its own
// (`$.process.spawn` writes its input once and closes it, so a long-lived child
// cannot be asked over stdin). Its stdout carries one `{"ready":"words"}` line,
// then nothing; stderr is its log, sent to the debug log here.
//
// One child at a time. Leaving the spawn's loop kills the child, and so does a
// module unload, which ends the loop; `stopServer` ends it. A child that ends
// by itself, or never starts, is not started again until the pane is closed
// and opened, and the status line says the passages are unavailable.
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'

import type { CentreHit, EntryPassages } from './passages'

export type Via = 'words' | 'meaning'
export type CentreAnswer = { by: Via; passages: CentreHit[] }

export type ServerConfig = {
  node: string
  serveur: string
  index: string
  graphe: string
  // Raised once the ready line came: the first query may go.
  onReady: () => void
  // Raised when the child ended by itself or could not start.
  onGone: () => void
  unavailable: string
}

// A socket left by a server that is gone answers nothing; a live one answers
// /health at once. A socket that neither answers nor refuses within this is
// left alone: it may be another session's server, busy.
const PROBE_MS = 500
// A child that has not said it is ready by then is ended (a cold start
// measured 4.5 s).
const READY_MS = 30_000
// What a connection to a socket nobody listens on, or to none, fails with:
// Node says ECONNREFUSED or ENOENT; Bun, which runs Claude Code, says
// FailedToOpenSocket for both (measured with Bun 1.3.11 on 2026-11-02). Any
// other failure (a refused fetch, say) leaves the socket alone.
const DEAD = /ECONNREFUSED|ENOENT|FailedToOpenSocket/
const SUFFIX = 'abcdefghijklmnopqrstuvwxyz0123456789'

type Child = { stream?: HookStream<ProcessSpawnChunk, ProcessSpawnResult>; socket?: string; isReady: boolean }

let child: Child | undefined
// Set when this opening's child ended by itself or never started.
let isSpent = false
// Whether the status line says the passages are unavailable.
let isStatusShown = false

const end = (c: Child): void => {
  void c.stream?.return({ code: null, signal: null }).catch(() => undefined)
}

function log($: EngineInterface, text: string): void {
  try {
    $.ui.log(`graphe: ${text}`, { to: 'debug' })
  } catch {
    // The debug log is a convenience.
  }
}

/** The socket to ask, once the child said it is ready; otherwise undefined. */
export const readySocket = (): string | undefined => (child?.isReady === true ? child.socket : undefined)

async function answers($: EngineInterface, socket: string): Promise<boolean> {
  const reply = $.http.fetch('http://graphe/health', { socketPath: socket }).then(
    () => true,
    (error: unknown) => !DEAD.test(describe(error)),
  )
  const late = $.clock.sleep(PROBE_MS).then(
    () => true,
    () => true,
  )

  return Promise.race([reply, late])
}

// The sockets of servers that are gone, under `dir`: each `.sock` that answers
// nothing is removed (`$.fs` has no unlink, so `rm`). Nothing else is touched.
async function sweep($: EngineInterface, dir: string): Promise<void> {
  const entries = await $.fs.list(dir).catch(() => [])
  const sockets = entries.filter(e => e.name.endsWith('.sock') && e.kind === 'other' && !e.isLink)
  await Promise.all(
    sockets.map(async e => {
      const path = `${dir}/${e.name}`
      if (await answers($, path)) return
      await $.process.run(['rm', '-f', '--', path]).catch(() => undefined)
      log($, `removed a dead socket, ${e.name}`)
    }),
  )
}

// An error's message, cause and code on one line, for DEAD.
function describe(error: unknown): string {
  const e = error as { cause?: unknown; code?: unknown } | null

  return [String(error), String(e?.cause ?? ''), String(e?.code ?? '')].join(' ')
}

const suffix = (): string => Array.from({ length: 4 }, () => SUFFIX[Math.floor(Math.random() * SUFFIX.length)]).join('')

/**
 * Starts the child, unless one is alive or this opening's has ended. Returns at
 * once: the sweep, the spawn and the wait for the ready line run on their own.
 */
export function startServer($: EngineInterface, config: ServerConfig): void {
  if (child !== undefined || isSpent) return
  const me: Child = { isReady: false }
  child = me
  void run($, me, config)
}

// This opening's child is over by itself: no other until the pane closes.
function gone($: EngineInterface, me: Child, config: ServerConfig, why: string): void {
  if (child !== me) return
  child = undefined
  isSpent = true
  log($, why)
  try {
    $.ui.status(config.unavailable)
    isStatusShown = true
  } catch {
    // The pane draws today's view whatever the status line says.
  }
  config.onGone()
}

async function run($: EngineInterface, me: Child, config: ServerConfig): Promise<void> {
  try {
    const tmp = ((await $.env.get('TMPDIR')) ?? '').replace(/\/+$/, '') || '/tmp'
    const dir = `${tmp}/graphe`
    await sweep($, dir)
    const session = (await $.session.id()).slice(0, 8)
    if (child !== me) return
    me.socket = `${dir}/${session}-${suffix()}.sock`
    const argv = [config.node, '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', config.serveur, '--index', config.index, '--graphe', config.graphe, '--socket', me.socket]
    me.stream = $.process.spawn({ argv })
    void $.clock.sleep(READY_MS).then(
      () => {
        if (child !== me || me.isReady) return
        gone($, me, config, `no ready line after ${READY_MS} ms`)
        end(me)
      },
      () => undefined,
    )
    let pending = ''
    for await (const { stream, text } of me.stream) {
      if (stream === 'stderr') {
        log($, text.trimEnd())
        continue
      }
      pending += text
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (me.isReady || line.trim() === '') continue
        try {
          if ((JSON.parse(line) as { ready?: unknown }).ready !== undefined) {
            me.isReady = true
            log($, `ready on ${me.socket}`)
            if (child === me) config.onReady()
          }
        } catch {
          log($, line)
        }
      }
    }
    gone($, me, config, 'the corpus server ended by itself')
  } catch (error) {
    gone($, me, config, `the corpus server could not run: ${String(error)}`)
  }
}

/** Ends the child, if any; the next opening may start one again. */
export function stopServer(): void {
  const c = child
  child = undefined
  isSpent = false
  if (c !== undefined) end(c)
}

/** Clears the status line the last child's end left, if it did. */
export function clearStatus($: EngineInterface): void {
  if (!isStatusShown) return
  isStatusShown = false
  try {
    $.ui.status(undefined)
  } catch {
    // Nothing beneath to clear.
  }
}

async function post($: EngineInterface, route: '/centre' | '/entry', body: unknown): Promise<unknown> {
  const socket = readySocket()
  if (socket === undefined) throw new Error('no corpus server')
  const reply = await $.http.fetch(`http://graphe${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    socketPath: socket,
  })
  if (!reply.ok) throw new Error(`${route}: ${reply.status}`)

  return JSON.parse(reply.text) as unknown
}

const hasPassages = (value: unknown): value is { passages: unknown[] } =>
  typeof value === 'object' && value !== null && Array.isArray((value as { passages?: unknown }).passages)

/** `POST /centre`: the passages that echo `text`, best first. */
export async function askCentre($: EngineInterface, text: string): Promise<CentreAnswer> {
  const answer = await post($, '/centre', { text })
  if (!hasPassages(answer)) throw new Error('/centre: no passages')
  const by = (answer as { by?: unknown }).by === 'meaning' ? 'meaning' : 'words'

  return { by, passages: answer.passages as CentreHit[] }
}

/** `POST /entry`: the passages a node's mentions fall in, with their neighbours. */
export async function askEntry($: EngineInterface, id: string): Promise<EntryPassages> {
  const answer = await post($, '/entry', { id })
  if (!hasPassages(answer)) throw new Error('/entry: no passages')

  return { passages: answer.passages as EntryPassages['passages'] }
}
