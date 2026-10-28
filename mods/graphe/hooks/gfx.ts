// Shared drawing vocabulary of the right-panel mods. A plugin cannot import
// from another plugin's folder, so this file is copied verbatim into each
// mod's hooks/; `gfx.test.ts` travels with it. Edit one copy, then copy it
// over the others: they must stay byte-identical.
//
// Everything here is pure: glyphs and colours in, strings out. Animation is a
// `tick` the caller bumps on a timer; nothing here keeps time.

// A raw colour is a hex the Text `color` prop takes on every surface. These
// sit mid-saturation so they read on a dark and a light ground alike.
export const HUE = {
  calm: '#3fae7a',
  warm: '#d9a521',
  hot: '#e0592f',
  cold: '#4a90c8',
  free: '#8a8f98',
} as const

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const
const LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0)

// A bar `width` cells wide filled to `fraction`, in eighths of a cell, as
// [filled, empty] so the caller colours each part.
export function bar(fraction: number, width: number): [string, string] {
  if (width <= 0) return ['', '']
  const eighths = Math.round(clamp01(fraction) * width * 8)
  const full = Math.floor(eighths / 8)
  const part = EIGHTHS[eighths % 8] ?? ''
  const filled = '█'.repeat(full) + part
  const used = full + (part === '' ? 0 : 1)

  return [filled, '░'.repeat(Math.max(0, width - used))]
}

// One cell per value, the last `width` values, scaled to `max` (or to the
// largest value when absent). An empty series is an empty string.
export function spark(values: readonly number[], width: number, max?: number): string {
  if (width <= 0) return ''
  const shown = values.slice(-width)
  const top = max ?? Math.max(0, ...shown)
  if (shown.length === 0) return ''
  return shown
    .map(v => (top <= 0 ? LEVELS[0] : LEVELS[Math.min(7, Math.max(0, Math.round(clamp01(v / top) * 7)))]))
    .join('')
}

// Green below `warn`, amber up to `hot`, red past it; on a 0..1 scale.
export function heat(fraction: number, warn = 0.7, hot = 0.9): string {
  if (fraction >= hot) return HUE.hot
  if (fraction >= warn) return HUE.warm
  return HUE.calm
}

export const spinner = (tick: number): string => SPINNER[((tick % SPINNER.length) + SPINNER.length) % SPINNER.length]!

// A glyph that beats: on for three ticks in four. For alerts, never for calm.
export const pulse = (tick: number, on: string, off = ' '): string => (tick % 4 === 3 ? off : on)

// Moves `from` a share `k` of the way to `to`, landing on it once close:
// called once per frame, a value glides instead of jumping.
export function ease(from: number, to: number, k = 0.35): number {
  const next = from + (to - from) * k
  return Math.abs(to - next) < 0.002 ? to : next
}

// A marquee: `text` scrolling inside `width` cells when longer, still otherwise.
export function marquee(text: string, width: number, tick: number): string {
  if (width <= 0) return ''
  if (text.length <= width) return text
  const loop = `${text}   `
  const at = tick % loop.length
  return (loop + loop).slice(at, at + width)
}

// A section rule: `── title ───…` across `width` cells.
export function rule(title: string, width: number): string {
  const head = title === '' ? '' : `── ${title} `
  return head.length >= width ? head.slice(0, width) : head + '─'.repeat(width - head.length)
}

export const cut = (text: string, width: number): string =>
  width <= 0 ? '' : text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…'

// The body width every pane of the right panel asks for when it opens. Each
// open sets the dock's width anew, so one shared figure keeps a tab switch
// from resizing it; the engine still caps it at 45% of the terminal, and a
// width the person dragged to wins.
export const PANE_COLUMNS = 80
