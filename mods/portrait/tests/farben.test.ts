import { describe, expect, test } from 'claude-code/testing'

import type { Line } from '../hooks/calligram'
import { TYPES, TYPE_HUE, activity, farben } from '../hooks/farben'
import type { MemoryType, Stamp } from '../hooks/farben'
import { HUE } from '../hooks/gfx'

const flat = (line: Line): string => line.map(s => s.text).join('')
const stamp = (mtimeMs: number, type: MemoryType): Stamp => ({ mtimeMs, type })
// How many squares the rows made of squares alone hold.
const squares = (lines: Line[]): number => lines.map(flat).filter(t => /^[■□]+$/.test(t)).reduce((sum, t) => sum + t.length, 0)

const ALL: Stamp[] = [stamp(30, 'user'), stamp(10, 'feedback'), stamp(20, 'project'), stamp(40, 'reference'), stamp(5, 'autre')]

describe('farben squares', () => {
  test('one square per memory, oldest first, in the hue of its type', () => {
    const out = farben(ALL, 0, 60)
    expect(flat(out[0]!)).toBe('── Farben · 5 souvenirs ' + '─'.repeat(60 - '── Farben · 5 souvenirs '.length))
    expect(out[1]!.map(s => s.color)).toEqual([TYPE_HUE.autre, TYPE_HUE.feedback, TYPE_HUE.project, TYPE_HUE.user, TYPE_HUE.reference])
    expect(flat(out[1]!)).toBe('■■■■■')
  })

  test('wraps to the width and keeps every memory', () => {
    const many = Array.from({ length: 95 }, (_, i) => stamp(i, TYPES[i % 4]!))
    const out = farben(many, 0, 30)
    expect(out.slice(1, 5).map(l => flat(l).length)).toEqual([30, 30, 30, 5])
    expect(squares(out)).toBe(95)
  })

  test('one dim hollow square per pending item after the memories, and a line naming them', () => {
    const out = farben(ALL, 3, 60)
    expect(flat(out[1]!)).toBe('■■■■■□□□')
    expect(out[1]!.at(-1)).toMatchObject({ text: '□□□', dim: true })
    expect(flat(out.at(-1)!)).toBe('□ 3 propositions en attente')
    expect(flat(farben(ALL, 1, 60).at(-1)!)).toBe('□ 1 proposition en attente')
    expect(farben(ALL, 0, 60).some(l => flat(l).includes('□'))).toBe(false)
  })

  test('says 1 souvenir, and draws nothing under the heading for none', () => {
    expect(flat(farben([stamp(1, 'user')], 0, 60)[0]!)).toContain('1 souvenir ')
    expect(farben([], 0, 60)).toHaveLength(1)
  })
})

describe('farben legend', () => {
  test('names every type present, with its count, and none that is absent', () => {
    const out = farben(ALL, 0, 60)
    expect(out.slice(2).map(flat)).toEqual(['■ feedback 1  ■ projet 1  ■ utilisateur 1  ■ référence 1', '■ autre 1'])
    expect(farben([stamp(1, 'user')], 0, 60).slice(2).map(flat)).toEqual(['■ utilisateur 1'])
  })

  test('never drops a type at 30 columns, however large the counts', () => {
    const big = TYPES.flatMap(t => Array.from({ length: 1234 }, (_, i) => stamp(i, t)))
    const out = farben(big, 12, 30)
    const legend = out.map(flat).filter(t => /^■ \w/.test(t))
    const text = legend.join('\n')
    for (const word of ['feedback 1234', 'projet 1234', 'utilisateur 1234', 'référence 1234', 'autre 1234']) expect(text).toContain(word)
    expect(legend.length).toBeGreaterThan(1)
    for (const line of out) expect(flat(line).length).toBeLessThanOrEqual(30)
    for (const type of TYPES) expect(out.some(l => l.some(s => s.text === '■' && s.color === TYPE_HUE[type]))).toBe(true)
  })

  test('no line is wider than the pane at 30, 40 and 60 columns', () => {
    const many = Array.from({ length: 200 }, (_, i) => stamp(i, TYPES[i % 5]!))
    for (const width of [30, 40, 60]) for (const line of farben(many, 7, width)) expect(flat(line).length).toBeLessThanOrEqual(width)
  })
})

describe('activity', () => {
  const days = Array.from({ length: 30 }, (_, i) => (i === 29 ? 2 : i === 0 ? 1 : 0))

  test('has a clear label and states the total', () => {
    const out = activity(days, 60)
    expect(flat(out[0]!)).toBe('── Activité · 30 derniers jours ' + '─'.repeat(60 - '── Activité · 30 derniers jours '.length))
    expect(out[1]![0]).toMatchObject({ color: HUE.cold })
    expect(out[1]![0]!.text).toHaveLength(30)
    expect(flat(out[1]!)).toEndWith(' 3 fichiers modifiés')
    expect(flat(activity([0, 1], 60)[1]!)).toEndWith(' 1 fichier modifié')
  })

  test('puts the total under the series, and shortens the heading, when the pane is narrow', () => {
    for (const width of [20, 30, 40]) for (const line of activity(days, width)) expect(flat(line).length).toBeLessThanOrEqual(width)
    const narrow = activity(days, 30)
    expect(flat(narrow[0]!)).toContain('Activité · 30 jours')
    expect(narrow.map(flat)).toContain('3 fichiers modifiés')
    expect(activity(days, 60)).toHaveLength(2)
  })
})
