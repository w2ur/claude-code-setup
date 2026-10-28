import { clock } from './forecast'
import { HUE, cut, heat } from './gfx'

// The pane's race scene as data: lines of styled segments already cut to the
// pane's width, so the drawing is testable without a renderer. A status is a
// theme semantic token (`tone`); a drawing takes a raw hex (`color`), except
// the camp, which keeps the theme's own text colour on purpose: black on a
// light ground, white on a dark one.

export type Tone = 'success' | 'error'
export type Seg = { text: string; tone?: Tone; color?: string; dim?: boolean; bold?: boolean }
export type Line = Seg[]

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// Below this the scene has no room to breathe: the pane keeps the plain gauge.
export const RACE_MIN_WIDTH = 30
// Usage that rose this recently keeps the runner moving.
export const RISE_MS = 10 * MINUTE
// A window's pace is only trusted once this much of it has gone by.
const MIN_ELAPSED = HOUR

export const WINDOW: Record<string, { span: number; name: string }> = {
  five_hour: { span: 5 * HOUR, name: '5-hour' },
  seven_day: { span: 7 * DAY, name: '7-day' },
}

export const canRace = (kind: string, width: number): boolean => WINDOW[kind] !== undefined && width >= RACE_MIN_WIDTH

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Local time, as the rest of the mod shows it: "Fri 31 Oct".
export function dateOf(ms: number): string {
  const d = new Date(ms)
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

// "3 d 4 h", "1 h 42", "42 min".
export function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE))
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)} d ${hours % 24} h`
  if (hours >= 1) return `${hours} h ${String(minutes % 60).padStart(2, '0')}`
  return `${minutes} min`
}

// The share of the window's time already gone, as a percentage.
export function evenPace(kind: string, now: number, resetsAt: number): number {
  const length = WINDOW[kind]?.span
  if (length === undefined) return 0
  return Math.min(100, Math.max(0, ((length - (resetsAt - now)) / length) * 100))
}

export type Projection = {
  // Where the window stands at its reset at this pace, uncapped.
  landing: number
  // When it reaches 100% if that happens before the reset.
  fullAt?: number
  basis: 'burn' | 'average'
}

// The 5-hour window projects at the measured burn rate. The 7-day burn rate
// comes from active hours and is extrapolated over nights and days off, so
// its projection uses the average pace since the window began instead.
export function projection(
  kind: string,
  pct: number,
  now: number,
  resetsAt: number,
  ratePerHour: number | undefined,
): Projection | undefined {
  const length = WINDOW[kind]?.span
  if (length === undefined) return undefined
  const isAverage = kind === 'seven_day'
  let rate = ratePerHour
  if (isAverage) {
    const elapsed = length - (resetsAt - now)
    rate = elapsed < MIN_ELAPSED ? undefined : pct / (elapsed / HOUR)
  }
  if (rate === undefined) return undefined
  const basis = isAverage ? 'average' : 'burn'
  if (rate <= 0) return { landing: pct, basis }
  const landing = pct + ((resetsAt - now) / HOUR) * rate
  const at = now + ((100 - pct) / rate) * HOUR
  return { landing, fullAt: landing >= 100 ? at : undefined, basis }
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

type Cell = { ch: string; color?: string; dim?: boolean }
type Style = { color?: string; dim?: boolean }

const ROWS = 4 // three sprite rows, then the ground

class Grid {
  readonly cells: Cell[][]

  constructor(readonly width: number) {
    this.cells = Array.from({ length: ROWS }, () => Array.from({ length: width }, (): Cell => ({ ch: ' ' })))
  }

  // A space in `text` leaves what is beneath; `isFree` keeps to empty cells.
  put(row: number, col: number, text: string, style: Style = {}, isFree = false): void {
    const line = this.cells[row]
    if (line === undefined) return
    ;[...text].forEach((ch, i) => {
      const at = col + i
      if (ch === ' ' || at < 0 || at >= this.width) return
      if (isFree && line[at]?.ch !== ' ') return
      line[at] = { ch, ...style }
    })
  }

  lines(): Line[] {
    return this.cells.map(row => {
      const end = row.findLastIndex(cell => cell.ch !== ' ') + 1
      const out: Seg[] = []
      for (const cell of row.slice(0, end)) {
        const last = out[out.length - 1]
        if (last !== undefined && last.color === cell.color && last.dim === cell.dim) last.text += cell.ch
        else out.push({ text: cell.ch, color: cell.color, dim: cell.dim })
      }
      return out
    })
  }
}

// Sprites: head, body, legs; three cells wide, centred on the runner's column.
const STAND: readonly [string, string] = [' | ', '/ \\']
const STRIDE: readonly (readonly [string, string])[] = [
  ['/|>', '/ >'],
  ['<|\\', ' |\\'],
]
const WALK: readonly [string, string][] = [
  ['/|\\', '/ \\'],
  ['/|\\', ' | '],
]

export type RaceInput = {
  kind: string
  pct: number
  // Where the runner is drawn while it glides to `pct`; defaults to `pct`.
  shown?: number
  resetsAt: number
  now: number
  ratePerHour?: number
  // The guard's threshold for this window, drawn as a hurdle.
  threshold?: number
  // Epoch ms of the last reading that moved up.
  lastRiseAt?: number
  tick: number
  width: number
}

function wrap(text: string, width: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line === '') line = cut(word, width)
    else if (line.length + 1 + word.length <= width) line += ` ${word}`
    else {
      out.push(line)
      line = cut(word, width)
    }
  }
  out.push(line)
  return out
}

type Note = { glyph: Seg; lines: string[]; tone?: Tone }

// Each note is led by the glyph it explains; its lines wrap under a hanging
// indent of the glyph's width.
function noteLines(notes: readonly Note[], width: number): Line[] {
  const out: Line[] = []
  for (const note of notes) {
    note.lines.forEach((text, li) => {
      wrap(text, width - 3).forEach((chunk, ci) => {
        if (li === 0 && ci === 0) out.push([note.glyph, { text: '  ' }, { text: chunk, tone: note.tone }])
        else out.push([{ text: `   ${chunk}`, tone: note.tone }])
      })
    })
  }
  return out
}

function header(name: string, left: number, width: number): Line {
  const options = [
    `── ${name} window ── resets in ${span(left)} ──`,
    `── ${name} ── resets in ${span(left)} ──`,
    `── ${name} ── ${span(left)} ──`,
  ]
  const text = options.find(o => o.length <= width) ?? cut(options[2] ?? '', width)

  return [{ text, dim: true }]
}

// Night, by the local clock: the camp lights up.
export const isNight = (ms: number): boolean => {
  const hour = new Date(ms).getHours()
  return hour >= 22 || hour < 6
}

export function raceLines(input: RaceInput): Line[] {
  const { kind, pct, resetsAt, now, tick, width } = input
  const meta = WINDOW[kind]
  if (meta === undefined || width < RACE_MIN_WIDTH) return []
  const shown = input.shown ?? pct

  const t0 = 1
  const t1 = width - 2
  const colOf = (p: number): number => t0 + Math.round((Math.min(100, Math.max(0, p)) / 100) * (t1 - t0))

  const proj = projection(kind, pct, now, resetsAt, input.ratePerHour)
  const isCrash = proj?.fullAt !== undefined
  const even = evenPace(kind, now, resetsAt)
  const isRising = input.lastRiseAt !== undefined && now - input.lastRiseAt <= RISE_MS
  const hue = heat(pct / 100)

  const grid = new Grid(width)
  for (let r = 0; r < 3; r++) grid.put(r, t1, '█', { color: HUE.hot })
  grid.put(3, t0, '═'.repeat(t1 - t0), { dim: true })
  grid.put(3, t1, '█', { color: HUE.hot })

  if (input.threshold !== undefined) {
    const at = colOf(input.threshold)
    grid.put(2, at, '╥', { color: HUE.warm })
    grid.put(3, at, '╨', { color: HUE.warm })
  }

  const runner = colOf(shown)
  const ghost = colOf(even)
  const [gBody, gLegs] = WALK[Math.floor(tick / 8) % 2] ?? WALK[0]!

  if (proj !== undefined) {
    if (isCrash) {
      grid.put(2, runner + 2, '┈'.repeat(Math.max(0, t1 - 1 - (runner + 2))), { color: hue, dim: true }, true)
      grid.put(2, t1 - 1, '✶', { color: HUE.hot })
    } else {
      // The camp: where the runner stops for the night when the window resets.
      // `apex` is the left cell of its peak; its base spans apex - 2 .. apex + 3.
      const apex = Math.min(t1 - 4, Math.max(runner + 4, colOf(proj.landing)))
      grid.put(2, runner + 2, '┈'.repeat(Math.max(0, apex - 2 - (runner + 2))), { color: hue, dim: true }, true)
      grid.put(0, apex, '/\\')
      grid.put(1, apex - 1, '/')
      grid.put(1, apex, isNight(now) ? '··' : '  ', { color: HUE.warm })
      grid.put(1, apex + 2, '\\')
      grid.put(2, apex - 2, '/____\\')
    }
  }

  // The ghost walks in front of the camp, the runner in front of both.
  grid.put(0, ghost, '◌', { dim: true })
  grid.put(1, ghost - 1, gBody, { dim: true })
  grid.put(2, ghost - 1, gLegs, { dim: true })

  const [body, legs] = isRising ? (STRIDE[Math.floor(tick / 2) % 2] ?? STRIDE[0]!) : STAND
  const head = pct <= 2 ? '\\o/' : isCrash ? ';o ' : ' o '
  grid.put(0, runner - 1, head, { color: hue })
  grid.put(1, runner - 1, body, { color: hue })
  grid.put(2, runner - 1, legs, { color: hue })

  const axis = new Grid(width)
  axis.put(0, t0, '0%')
  axis.put(0, colOf(50) - 1, '50%')
  axis.put(0, t1 - 3, '100%')

  const notes: Note[] = [
    { glyph: { text: 'o', color: hue }, lines: [`You've used ${Math.round(pct)}%.`] },
    { glyph: { text: '◌', dim: true }, lines: [`An even pace would be at ${Math.round(even)}% now.`] },
  ]
  const pace = proj?.basis === 'average' ? 'At your average pace' : 'At this pace'
  if (proj === undefined) {
    notes.push({ glyph: { text: '·', dim: true }, lines: ['Measuring your pace.'] })
  } else if (proj.fullAt !== undefined) {
    const when = kind === 'seven_day' ? `on ${dateOf(proj.fullAt)} around ${clock(proj.fullAt)}` : `at ${clock(proj.fullAt)}`
    notes.push({
      glyph: { text: '✶', color: HUE.hot },
      lines: [`${pace}, you hit the limit`, `${when}, ${span(resetsAt - proj.fullAt)} before the reset.`],
      tone: 'error',
    })
  } else {
    const on = kind === 'seven_day' ? ` on ${dateOf(resetsAt)}` : ''
    const lines =
      proj.landing <= pct
        ? [`Not rising now: you camp at ${Math.round(pct)}%`, `when the window resets${on}.`]
        : [`${pace}, you camp at ${Math.min(99, Math.round(proj.landing))}%`, `when the window resets${on}.`]
    notes.push({ glyph: { text: '⌂' }, lines })
    notes.push({ glyph: { text: ' ' }, lines: ['✓ You have room.'], tone: 'success' })
  }
  if (input.threshold !== undefined && pct >= input.threshold) {
    notes.push({ glyph: { text: '╥', color: HUE.warm }, lines: [`Past ${input.threshold}%, fan-outs ask before starting.`] })
  }

  return [header(meta.name, resetsAt - now, width), ...grid.lines(), ...axis.lines().slice(0, 1), ...noteLines(notes, width)]
}
