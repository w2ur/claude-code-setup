import type { EngineInterface, HookOf, PluginOptions, Register, Timer } from 'claude-code'
import { calligram, gauge } from './calligram'
import type { Line as Drawn, Projection } from './calligram'
import { TYPES, activity, farben } from './farben'
import type { MemoryType, Stamp } from './farben'
import { STRINGS, langOf } from './strings'
import type { Strings } from './strings'
import { PANE_COLUMNS, cut, ease, rule } from './gfx'

const PANE = 'portrait'
// The strings of the `lang` option, set once by register.
let t: Strings = STRINGS.fr
const paneArgs = () => ({ id: PANE, title: t.paneTitle, columns: PANE_COLUMNS })
// The command always registered; `alias` (userConfig) adds a second name.
const COMMAND = 'portrait'
const RECENT = 8
// The window of the activity sparkline, one cell per day.
const DAYS = 30
const DAY_MS = 86_400_000
// The fill of the calligram and the gauge: one frame every 125 ms, half the
// remaining way each frame, so it lands in about a second.
const FRAME_MS = 125
const FILL_EASE = 0.5
// The `$.store` key remembering that the owner opened the pane.
const REMEMBER = 'paneOpen'
// The panel mod's two answers to /panel (mods/panel/hooks/register.tsx).
const PANEL_OPENED = 'Panel opened.'
const PANEL_CLOSED = 'Panel closed.'

type Tone = 'warning' | 'claude' | 'success' | 'subtle' | 'error'

const TYPE_TONE: Readonly<Record<string, Tone>> = {
  feedback: 'warning',
  project: 'claude',
  user: 'success',
  reference: 'subtle',
}

// An exit code of the check script, as a colour: 0 healthy, 1 a finding, 2 unknown.
const EXIT_TONE: Readonly<Record<number, Tone>> = { 0: 'success', 1: 'warning', 2: 'error' }

type Memory = { date: string; type: string; description: string }
// What the memory folders hold: the newest few in full, every memory's date and
// type, and the files modified per day over the last DAYS days (today last).
type Recent = { shown: Memory[]; all: Stamp[]; days: number[] }
// One pending proposition file: its date and its numbered lines, as written.
type Proposal = { date: string; lines: string[] }
type Line = { text: string; tone?: Tone; isHeading?: boolean; dim?: boolean }

// Set by each /portrait: `tout` shows the whole portrait instead of the key points.
let isWhole = false
// The name the last run was typed under, so usage lines repeat what the owner typed.
let typed = COMMAND

async function expand($: EngineInterface, path: string): Promise<string> {
  if (path !== '~' && !path.startsWith('~/')) return path
  const home = await $.env.get('HOME')

  return home === undefined || home === '' ? path : home + path.slice(1)
}

// Breaks a line at spaces so that no piece is longer than the pane; a word
// longer than the pane is cut.
function wrap(text: string, width: number): string[] {
  if (text.length <= width) return [text]
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const next = line === '' ? word : `${line} ${word}`
    if (next.length <= width) {
      line = next
      continue
    }
    if (line !== '') out.push(line)
    let rest = word
    while (rest.length > width) {
      out.push(rest.slice(0, width))
      rest = rest.slice(width)
    }
    line = rest
  }
  if (line !== '') out.push(line)

  return out
}

// The key points heading, in either language: a portrait written in one is read
// whatever the `lang` option says.
const KEY_POINTS = /^##\s+(?:Points clés|Key points)\s*$/i

// The lines of the key points section, without its heading.
function keyPoints(text: string): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex(l => KEY_POINTS.test(l))
  if (start < 0) return []
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(l => /^##\s/.test(l))
  const body = end < 0 ? rest : rest.slice(0, end)
  while (body.length > 0 && body[0]!.trim() === '') body.shift()
  while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop()

  return body.map(l => l.trimEnd())
}

function field(front: string, name: string): string {
  const found = new RegExp(`^\\s*${name}:\\s*(.*)$`, 'm').exec(front)

  return (found?.[1] ?? '').trim().replace(/^["']|["']$/g, '')
}

const two = (n: number): string => String(n).padStart(2, '0')
const dateOf = (ms: number): string => {
  const d = new Date(ms)

  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

const typeOf = (raw: string): MemoryType => TYPES.find(known => known === raw) ?? 'autre'

const midnight = (ms: number): number => new Date(ms).setHours(0, 0, 0, 0)

// Files per day over the last DAYS days, the oldest first and today last; a
// file stamped in the future, or older than the window, counts for no day.
function perDay(mtimes: readonly number[], now: number): number[] {
  const days = Array.from({ length: DAYS }, () => 0)
  for (const mtime of mtimes) {
    const ago = Math.round((midnight(now) - midnight(mtime)) / DAY_MS)
    if (ago >= 0 && ago < DAYS) days[DAYS - 1 - ago]! += 1
  }

  return days
}

// The front matter of a memory file, and the fields the pane takes from it.
async function front($: EngineInterface, path: string): Promise<{ type: string; description: string }> {
  const text = await $.fs.read(path).catch(() => '')
  const head = /^---\n([\s\S]*?)\n---/.exec(typeof text === 'string' ? text : '')?.[1] ?? ''

  return { type: field(head, 'type'), description: field(head, 'description') }
}

// The day series comes from the mtimes alone; the type of every memory needs
// its front matter, so every file is read once per run, never per drawing.
async function recent($: EngineInterface, root: string, now: number): Promise<Recent> {
  const found: { path: string; mtimeMs: number }[] = []
  const projects = await $.fs.list(root).catch(() => [])
  for (const project of projects.filter(p => p.kind === 'dir')) {
    const dir = `${root}/${project.name}/memory`
    const files = await $.fs.list(dir).catch(() => [])
    for (const file of files) {
      if (file.kind !== 'file' || !file.name.endsWith('.md') || file.name === 'MEMORY.md') continue
      const path = `${dir}/${file.name}`
      const stat = await $.fs.stat(path).catch(() => undefined)
      if (stat !== undefined) found.push({ path, mtimeMs: stat.mtimeMs })
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const all: Stamp[] = []
  const shown: Memory[] = []
  for (const [i, one] of found.entries()) {
    const read = await front($, one.path)
    all.push({ mtimeMs: one.mtimeMs, type: typeOf(read.type) })
    if (i < RECENT) shown.push({ date: dateOf(one.mtimeMs), ...read })
  }

  return { shown, all, days: perDay(found.map(f => f.mtimeMs), now) }
}

// `size` is the portrait length and its threshold, when the line states them.
type Verdict = { said: string; tone: Tone; size?: { n: number; limit: number } }

// "… is 3996 characters (threshold 4000)": the numbers of the check's first line.
function sizeOf(line: string): Verdict['size'] {
  const found = /(\d+) characters \(threshold (\d+)\)/.exec(line)
  const limit = Number(found?.[2])

  return found === null || limit <= 0 ? undefined : { n: Number(found[1]), limit }
}

// The check script's own line, without the portrait path it repeats.
async function verdict($: EngineInterface, portrait: string, check: string): Promise<Verdict> {
  const ran = await $.process.run([check], { env: { PORTRAIT: portrait } }).then(
    r => ({ code: r.exitCode, said: (r.stdout.trim() || r.stderr.trim()).split('\n')[0] ?? '' }),
    () => undefined,
  )
  if (ran === undefined) return { said: t.checkUnavailable, tone: 'error' }

  return { said: ran.said.replace(`${portrait} `, ''), tone: EXIT_TONE[ran.code] ?? 'error', size: sizeOf(ran.said) }
}

const PROPOSAL_NAME = /^proposition-(\d{4}-\d{2}-\d{2})\.md$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
// Where an applied `+` line goes: the script cannot know which section a new
// fact belongs to, so the owner files it by hand. Either language's heading is
// found; a portrait with neither gets the `lang` option's.
const TO_FILE = [STRINGS.fr.toFileHeading, STRINGS.en.toFileHeading]
// The first line a retired proposition gets under `traitees/`. Data, not
// display: the pane never shows it, so it stays the same in every language.
const RETIRED_DISCARDED = 'écartée'
const RETIRED_APPLIED = 'appliquées: '

// Pending propositions, oldest first. Treated ones sit under `traitees/`, a
// directory, so a listing of files leaves them out. A date already copied
// there is treated too: a move whose removal failed leaves the original behind,
// and applying it again would add every `+` twice.
async function pending($: EngineInterface, dir: string): Promise<Proposal[]> {
  const entries = await $.fs.list(dir).catch(() => [])
  const done = new Set((await $.fs.list(`${dir}/traitees`).catch(() => [])).map(e => e.name))
  const out: Proposal[] = []
  for (const entry of entries) {
    const date = entry.kind === 'file' && !done.has(entry.name) ? PROPOSAL_NAME.exec(entry.name)?.[1] : undefined
    if (date === undefined) continue
    const text = await $.fs.read(`${dir}/${entry.name}`).catch(() => '')
    const lines = (typeof text === 'string' ? text : '').split('\n').filter(l => l.trim() !== '')
    out.push({ date, lines })
  }

  return out.sort((a, b) => a.date.localeCompare(b.date))
}

type Item = { n: number; op: '+' | '~' | '-'; text: string }

// `N. [op] texte — source`; the source is after the last dash, since a text
// may carry one of its own.
function parseItem(line: string): Item | undefined {
  const found = /^(\d+)\. \[([+~-])\] (.*)$/.exec(line)
  if (found === null) return undefined
  const rest = found[3]!
  const cutAt = rest.lastIndexOf(' — ')

  return { n: Number(found[1]), op: found[2] as Item['op'], text: (cutAt < 0 ? rest : rest.slice(0, cutAt)).trim() }
}

// `ancien: … | nouveau: …`, the text of a `~` item.
const PAIR = /^ancien: (.+) \| nouveau: (.+)$/

const bullet = (text: string): string => (text.startsWith('- ') ? text : `- ${text}`)

type Applied = { text: string } | { missing: number } | { ambiguous: number }

// Applies the items in order, or names the first one that no longer matches the
// portrait, or matches it in more than one place; all or nothing, so a
// half-applied proposition never reaches the disk.
function applyItems(portrait: string, items: Item[]): Applied {
  let text = portrait
  const added: string[] = []
  for (const item of items) {
    if (item.op === '+') {
      added.push(bullet(item.text))
      continue
    }
    if (item.op === '~') {
      const pair = PAIR.exec(item.text)
      const at = pair === null ? -1 : text.indexOf(pair[1]!)
      if (pair === null || at < 0) return { missing: item.n }
      if (at !== text.lastIndexOf(pair[1]!)) return { ambiguous: item.n }
      text = text.slice(0, at) + pair[2]! + text.slice(at + pair[1]!.length)
      continue
    }
    const lines = text.split('\n')
    const at = lines.findIndex(l => l.trimEnd() === item.text)
    if (at < 0) return { missing: item.n }
    if (lines.some((l, i) => i > at && l.trimEnd() === item.text)) return { ambiguous: item.n }
    lines.splice(at, 1)
    text = lines.join('\n')
  }
  if (added.length === 0) return { text }

  const lines = text.replace(/\n+$/, '').split('\n')
  const heading = lines.findIndex(l => TO_FILE.includes(l.trim()))
  if (heading < 0) return { text: [...lines, '', t.toFileHeading, '', ...added, ''].join('\n') }
  const next = lines.findIndex((l, i) => i > heading && /^##\s/.test(l))
  let end = next < 0 ? lines.length : next
  while (end > heading + 1 && lines[end - 1]!.trim() === '') end -= 1
  lines.splice(end, 0, ...added)

  return { text: lines.join('\n') + '\n' }
}

// Every item of the pending propositions, oldest proposition first.
const itemsOf = (proposals: readonly Proposal[]): Item[] =>
  proposals.flatMap(p => p.lines.map(parseItem).filter((i): i is Item => i !== undefined))

// The portrait's size once every pending item is applied, and the text they add.
// The items go through applyItems on the snapshot alone, and the check's own
// count moves by the length they change. When one no longer matches the
// portrait, applyItems refuses the lot: the size is then an estimate, the added
// lengths less the removed ones.
function project(portrait: string | undefined, n: number, items: readonly Item[]): Projection | undefined {
  if (items.length === 0) return undefined
  const added = items.flatMap(i => (i.op === '+' ? [i.text] : i.op === '~' ? [PAIR.exec(i.text)?.[2] ?? ''] : []))
  const text = added.join(' ')
  const applied = portrait === undefined ? undefined : applyItems(portrait, [...items])
  if (portrait !== undefined && applied !== undefined && 'text' in applied) return { size: n + applied.text.length - portrait.length, text }
  const delta = items.reduce((sum, i) => {
    if (i.op === '+') return sum + bullet(i.text).length + 1
    if (i.op === '-') return sum - i.text.length - 1
    const pair = PAIR.exec(i.text)

    return pair === null ? sum : sum + pair[2]!.length - pair[1]!.length
  }, 0)

  return { size: Math.max(0, n + delta), text }
}

// Moves a proposition under `traitees/` with `first` as its new first line.
// `$.fs` has no rename or delete: write the copy, then remove the original.
async function retire($: EngineInterface, dir: string, date: string, text: string, first: string): Promise<boolean> {
  const name = `proposition-${date}.md`
  await $.fs.write(`${dir}/traitees/${name}`, `${first}\n${text}`)

  return $.process.run(['/bin/rm', '--', `${dir}/${name}`]).then(
    r => r.exitCode === 0,
    () => false,
  )
}

type Verb = 'whole' | 'apply' | 'discard'

// The verb a word names, in either language: `tout`/`all`, `applique`/`apply`,
// `ecarte`/`discard`.
function verbOf(word: string | undefined): Verb | undefined {
  for (const s of [STRINGS.fr, STRINGS.en]) {
    if (word === s.verbWhole) return 'whole'
    if (word === s.verbApply) return 'apply'
    if (word === s.verbDiscard) return 'discard'
  }

  return undefined
}

// `/portrait applique <date> <n…>` and `/portrait ecarte <date>` (or `apply`,
// `discard`); the reply text.
async function act($: EngineInterface, options: PluginOptions, verb: 'apply' | 'discard', words: string[]): Promise<string> {
  const [, date, ...numbers] = words
  const usage = verb === 'apply' ? t.usageApply(typed) : t.usageDiscard(typed)
  if (date === undefined || !DATE.test(date)) return usage
  const p = await locate($, options)
  const path = `${p.propositions}/proposition-${date}.md`
  if (!(await $.fs.exists(path))) return t.noProposal(date)
  if (await $.fs.exists(`${p.propositions}/traitees/proposition-${date}.md`)) return t.alreadyTreated(date)
  const proposal = String(await $.fs.read(path))

  if (verb === 'discard') return (await retire($, p.propositions, date, proposal, RETIRED_DISCARDED)) ? t.discarded(date) : t.stuck

  const chosen = [...new Set(numbers.map(Number))]
  if (chosen.length === 0 || chosen.some(n => !Number.isInteger(n) || n <= 0)) return usage
  const items = proposal.split('\n').map(parseItem).filter((i): i is Item => i !== undefined)
  const unknown = chosen.filter(n => !items.some(i => i.n === n))
  if (unknown.length > 0) return t.unknownNumbers(unknown.join(', '))
  if (!(await $.fs.exists(p.portrait))) return t.noPortraitApplied

  const before = String(await $.fs.read(p.portrait))
  const result = applyItems(before, chosen.map(n => items.find(i => i.n === n)!))
  if ('missing' in result) return t.refusedMissing(result.missing)
  if ('ambiguous' in result) return t.refusedAmbiguous(result.ambiguous)

  // The check reads the file, so the new text is written first and the old one
  // kept here to put back.
  await $.fs.write(p.portrait, result.text)
  const code = await $.process.run([p.check], { env: { PORTRAIT: p.portrait } }).then(
    r => r.exitCode,
    () => 2,
  )
  if (code !== 0) {
    const isRestored = await $.fs.write(p.portrait, before).then(
      () => true,
      () => false,
    )
    if (!isRestored) return code === 1 ? t.restoreFailedThreshold : t.restoreFailedCheck

    return code === 1 ? t.refusedThreshold : t.refusedCheck
  }

  const list = chosen.join(', ')

  return (await retire($, p.propositions, date, proposal, `${RETIRED_APPLIED}${list}`)) ? t.applied(list) : t.appliedStuck(list, t.stuck)
}

async function locate($: EngineInterface, options: PluginOptions) {
  return {
    portrait: await expand($, String(options.portrait)),
    memoires: await expand($, String(options.memoires)),
    check: await expand($, String(options.check)),
    propositions: await expand($, String(options.propositions)),
  }
}

// What the last /portrait read from the disk; drawing only reads this.
type Snapshot = { portrait: string | undefined; memories: Recent; proposals: Proposal[]; verdict: Verdict }

async function load($: EngineInterface, options: PluginOptions): Promise<Snapshot> {
  const p = await locate($, options)
  const portrait = (await $.fs.exists(p.portrait)) ? String(await $.fs.read(p.portrait)) : undefined

  return {
    portrait,
    memories: await recent($, p.memoires, await now($)),
    proposals: await pending($, p.propositions),
    verdict: await verdict($, p.portrait, p.check),
  }
}

let snapshot: Snapshot | undefined

// The engine's clock, or the system's when nothing answers it.
const now = ($: EngineInterface): Promise<number> => Promise.resolve().then(() => $.clock.now()).catch(() => Date.now())

// How far the calligram is filled, 0 to 1. A reload that
// leaves the pane open finds them full: only a run or an opening replays the fill.
let fill = 1
let timer: Timer | undefined

// One frame: while the pane is shown and the fill is not done, glide it on and
// redraw. A full fill redraws nothing, so an idle pane costs no frames. A pane
// found hidden ends the animation and lands the fill: nothing tells this mod
// when a tab comes forward, so no timer waits for it.
async function frame($: EngineInterface): Promise<void> {
  const mine = timer
  const panes = fill >= 1 ? [] : await $.ui.panes().catch(() => [])
  // A replay during the wait has started a newer timer: this frame is stale.
  if (timer !== mine) return
  if (fill >= 1 || !panes.some(p => p.id === PANE && p.isShown)) {
    timer?.cancel()
    timer = undefined
    fill = 1
    return
  }
  fill = ease(fill, 1, FILL_EASE)
  $.ui.invalidate('ui.render')
}

// Replays the fill from empty, on the one timer this module keeps.
function replay($: EngineInterface): void {
  fill = 0
  timer?.cancel()
  timer = $.clock.every(FRAME_MS, () => void frame($))
}

// The configured alias, or undefined when it is empty or repeats COMMAND. A
// leading slash in the setting is forgiven.
function aliasOf(setting: unknown): string | undefined {
  const name = String(setting ?? '').trim().replace(/^\//, '')

  return name === '' || name === COMMAND ? undefined : name
}

// The plugin's options, set once by register so the top-level handler reads them.
let settings: PluginOptions = {}

// One handler for both names; `e.command` says which one was typed.
const answer: HookOf<'command.run'> = async ($, e) => {
  typed = e.command
  const words = e.args.trim().split(/\s+/).filter(w => w !== '')
  const verb = verbOf(words[0])
  // An application changes the disk, so it runs before the snapshot is read.
  const isAct = verb === 'apply' || verb === 'discard'
  const said = isAct ? await act($, settings, verb, words) : undefined
  if (!isAct) isWhole = verb === 'whole'
  snapshot = await load($, settings)
  replay($)
  const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
  // A second run redraws the pane it opened; it never opens another.
  if (isUp) $.ui.invalidate('ui.render')
  else {
    await $.ui.open(paneArgs())
    await $.store.set(REMEMBER, true).catch(() => undefined)
  }

  return { text: said ?? (isWhole ? t.replyWhole : t.replyKeyPoints) }
}

export const register: Register = (on, options) => {
  settings = options
  t = STRINGS[langOf(options.lang)]
  const alias = aliasOf(options.alias)
  const names = alias === undefined ? [COMMAND] : [COMMAND, alias]

  on('session.start', async ($, e, next) => {
    for (const name of names) {
      await $.command.register({ name, description: t.commandDescription })
    }

    // A pane the owner opened comes back unasked; the snapshot is read first so
    // that its first drawing has something to draw.
    // Detached: the session must not wait on the disk reads.
    void (async () => {
      if ((await $.store.get(REMEMBER).catch(() => undefined)) !== true) return
      snapshot = await load($, options)
      replay($)
      await $.ui.open(paneArgs())
    })().catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'panel' }, async ($, e, next) => {
    const answer = await next(e)
    try {
      if (answer.text === PANEL_OPENED) {
        snapshot = await load($, options)
        replay($)
        await $.ui.open(paneArgs())
        await $.store.set(REMEMBER, true).catch(() => undefined)
      } else if (answer.text === PANEL_CLOSED) {
        await $.ui.close({ id: PANE })
        await $.store.set(REMEMBER, false).catch(() => undefined)
      }
    } catch {
      // The tab is this mod's affair; the panel's answer stands.
    }

    return answer
  })

  // Only the owner's own close is forgotten; an unload or a plugin close is not.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await $.store.delete(REMEMBER).catch(() => undefined)

    return next(e)
  })

  // The command name is a literal so the workflow guide can read it; the alias
  // lives in the owner's settings, never in this published file.
  on('command.run', { command: 'portrait' }, answer)
  if (alias !== undefined) on('command.run', { command: alias }, answer)

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const width = e.props.bodyColumns
    // A reload while the pane stays open leaves no snapshot: read once.
    snapshot ??= await load($, options)
    const { portrait: text, memories, proposals, verdict: foot } = snapshot
    const lines: Line[] = []

    if (text !== undefined) {
      const source = isWhole ? text.split('\n').map(l => l.trimEnd()) : keyPoints(text)
      for (const raw of source) {
        for (const piece of wrap(raw, width)) lines.push({ text: piece, isHeading: isWhole && /^#/.test(raw) })
      }
    } else {
      lines.push({ text: cut(t.noPortrait, width), dim: true })
    }

    // The bust stands for the size; a pane too narrow for it keeps the gauge line,
    // and a check that stated no size keeps the coloured verdict line.
    const size = foot.size
    const items = itemsOf(proposals)
    const bust =
      size === undefined
        ? undefined
        : (calligram({ portrait: text, n: size.n, limit: size.limit, fill, width, projection: project(text, size.n, items), strings: t }) ?? [
            gauge(size.n, size.limit, fill, width, t),
          ])
    // A line of styled segments as one Text; an empty line keeps its row.
    const draw = (line: Drawn) => (
      <Text>
        {line.length === 0
          ? ' '
          : line.map(seg => (
              <Text color={seg.tone ?? seg.color} dimColor={seg.dim === true} weight={seg.bold === true ? 'semibold' : 'regular'}>
                {seg.text}
              </Text>
            ))}
      </Text>
    )

    return (
      <Box flexDirection="column">
        {bust === undefined ? <Text color={foot.tone}>{cut(foot.said, width)}</Text> : bust.map(draw)}
        <Text> </Text>
        {lines.map(l => (
          <Text weight={l.isHeading === true ? 'semibold' : 'regular'} dimColor={l.dim === true}>
            {l.text === '' ? ' ' : l.text}
          </Text>
        ))}
        <Text> </Text>
        {farben(memories.all, items.length, width, t).map(draw)}
        <Text> </Text>
        {activity(memories.days, width, t).map(draw)}
        <Text> </Text>
        <Text weight="semibold">{rule(t.recentHeading, width)}</Text>
        {memories.shown.map(m => (
          <Text>
            <Text dimColor>{m.date} </Text>
            <Text color={TYPE_TONE[m.type] ?? 'subtle'}>{m.type}</Text>
            <Text> {cut(m.description, width - m.date.length - m.type.length - 2)}</Text>
          </Text>
        ))}
        <Text> </Text>
        <Text weight="semibold">{rule(t.proposalsHeading, width)}</Text>
        {proposals.length === 0 ? <Text dimColor>{t.noProposals}</Text> : null}
        {proposals.flatMap(p => [
          <Text dimColor>{cut(t.proposalHint(p.date, typed), width)}</Text>,
          ...p.lines.flatMap(l => wrap(l, width)).map(piece => <Text>{piece}</Text>),
        ])}
        {bust === undefined ? <Text> </Text> : null}
        {bust === undefined ? <Text color={foot.tone}>{cut(foot.said, width)}</Text> : null}
      </Box>
    )
  })
}
