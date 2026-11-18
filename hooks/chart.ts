/* The Council scorecard as an SVG: one block per lens, its name and verdict on a line and its latest
 * score below as a bar on a 0-10 scale, earlier rounds as hollow rings (older ones fainter), and the
 * target as a dashed rule. Status colors (at target, below) always ride with a text label, never
 * alone. Narrow by design (380px, 13px text) so it stays legible in a docked pane or on a phone.
 * Pure: no engine calls. */
import type { CouncilCycle } from '../types'
import { REPLACED, counts, fixedLenses, formatScore, lensKey } from './logic'

export type LensRow = {
  lens: string
  /** Scores from earlier rounds this cycle, oldest first. */
  history: number[]
  latest: { state: 'scored' | 'running' | 'failed' | 'stopped' | 'absent'; score: number | null }
}

/** Each lens of the cycle (round 1's first, in order), with its latest-round seat and its history. */
export function lensRows(cycle: CouncilCycle): LensRow[] {
  const latest = cycle.rounds.at(-1)
  const order = new Map<string, string>()
  for (const lens of fixedLenses(cycle)) order.set(lensKey(lens), lens)
  for (const seat of latest?.seats.filter(counts) ?? []) if (!order.has(lensKey(seat.lens))) order.set(lensKey(seat.lens), seat.lens.trim())

  return [...order].map(([key, lens]) => {
    const history = cycle.rounds.slice(0, -1)
      .flatMap(round => round.seats.filter(s => counts(s) && s.score !== null && lensKey(s.lens) === key).map(s => s.score!))
    const seats = latest?.seats.filter(s => counts(s) && lensKey(s.lens) === key) ?? []
    const seat = seats.filter(s => s.score !== null).at(-1) ?? seats.at(-1)
    // A reviewer stopped before it scored (accepted, Council off, a new round) is stopped, not unseated.
    const stopped = latest?.seats.some(s => lensKey(s.lens) === key && s.state === 'abandoned' && s.score === null && s.note !== REPLACED)
    const state = seat ? (seat.score !== null ? 'scored' : seat.state === 'running' ? 'running' : 'failed') : stopped ? 'stopped' : 'absent'

    return { lens, history, latest: { state, score: seat?.score ?? null } }
  })
}

/** A lens's state in words, the same in the chart, its alt and the bars elsewhere. */
export const stateWord = (state: LensRow['latest']['state']): string =>
  state === 'running' ? 'reviewing…' : state === 'failed' ? 'no score' : state === 'stopped' ? 'stopped' : state === 'absent' ? 'not seated' : ''

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }
/** Characters no lens name may carry into the document: what XML forbids (control characters, a half of
 *  a surrogate pair, U+FFFE/U+FFFF) and bidi overrides, which would reverse the text drawn after them. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F‪-‮⁦-⁩￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
/** Text as XML character data: markup escaped, forbidden characters dropped. */
export const esc = (text: string): string => text.replace(FORBIDDEN, '').replace(/[&<>"']/g, c => ESCAPES[c] ?? c)

/** The text's user-perceived characters: a family emoji, a flag or an accented letter is one. */
export function graphemes(text: string): string[] {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter
  if (Segmenter) return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(text), part => part.segment)

  return Array.from(text)
}

/** Pixels per spacing code point at 13px in scripts whose letters run wider than Latin (measured). */
const SCRIPT_WIDTHS: readonly (readonly [number, number, number])[] = [
  [0x0d00, 0x0d7f, 15], // Malayalam
  [0x0b80, 0x0bff, 12], // Tamil
  [0x0c00, 0x0cff, 11.5], // Telugu, Kannada
  [0x0980, 0x0aff, 10], // Bengali, Gurmukhi, Gujarati
  [0x0b00, 0x0b7f, 10], // Oriya
  [0x0d80, 0x0dff, 10.5], // Sinhala
  [0x1000, 0x109f, 10.5], // Myanmar
  [0x1780, 0x17ff, 10.5], // Khmer
  [0x0900, 0x097f, 8.8], // Devanagari
  [0x10a0, 0x10ff, 8.6], // Georgian
  [0x0590, 0x08ff, 7.5], // Hebrew, Arabic
]

/** A grapheme's drawn width at 13px, in pixels (system UI fonts, a little generous). A wrong guess never
 *  covers the verdict: the name column is clipped as well. */
export function pixelWidth(grapheme: string): number {
  const code = grapheme.codePointAt(0) ?? 0
  // Emoji: pictographs drawn as emoji, anything with an emoji or keycap selector.
  if (/\p{Emoji_Presentation}|️|⃣/u.test(grapheme) || code >= 0x1f000) return 18
  if ((code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60)) return 13.5
  const script = SCRIPT_WIDTHS.find(([from, to]) => code >= from && code <= to)
  if (script) {
    // Every code point that takes room: letters and spacing vowel signs, not the marks that stack.
    const spacing = Array.from(grapheme).filter(c => !/\p{Mn}|\p{Me}|‍|‌/u.test(c)).length

    return script[2] * Math.max(1, spacing)
  }
  if (/^[MWmw@%]/.test(grapheme)) return 12
  if (/^\p{Lu}/u.test(grapheme)) return code < 0x80 ? 9.2 : 10.8
  if (/^[0-9]/.test(grapheme)) return 7.6
  if (/^[iIlj.,:;'|!]/.test(grapheme)) return 3.8
  if (/^[frt() -]/.test(grapheme)) return 5

  return 7.4
}

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/

/** Clips to a drawn width, by whole graphemes, with an ellipsis that fits within it too, at the visual
 *  end of a right-to-left name. */
export function clipWidth(text: string, px: number): string {
  const parts = graphemes(text)
  const total = parts.reduce((sum, part) => sum + pixelWidth(part), 0)
  if (total <= px) return text
  const room = px - pixelWidth('…')
  let used = 0, cut = 0
  for (; cut < parts.length; cut++) {
    const next = used + pixelWidth(parts[cut]!)
    if (next > room) break
    used = next
  }

  return `${parts.slice(0, cut).join('').trimEnd()}…${RTL.test(text) ? '‏' : ''}`
}

const r1 = (n: number): number => Math.round(n * 10) / 10

// Chart chrome and ink: the frame follows the host's color scheme, light by default, dark under
// prefers-color-scheme; the status steps are fixed, each bar edged in a darker step of its own hue so it
// stands off its track. The chart paints its own surface, so its ink never lands on a background of the
// other scheme.
const STYLE = `<style>
:root{color-scheme:light dark}
text{font:13px system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums}
.small{font-size:12px}
.bg{fill:#fcfcfb}.ink{fill:#0b0b0b}.ink2{fill:#52514e}.muted{fill:#6f6d68}
.grid{stroke:#e1e0d9;stroke-width:1}.track{fill:#efeee9}
.target{stroke:#52514e;stroke-width:1.5;stroke-dasharray:4 3}
.good{fill:#0ca30c;stroke:#066b06;stroke-width:1}.warn{fill:#fab219;stroke:#9a6700;stroke-width:1}
.hist{fill:#fcfcfb;stroke:#52514e;stroke-width:2}
@media (prefers-color-scheme:dark){.bg{fill:#1a1a19}.ink{fill:#f0efec}.ink2{fill:#c3c2b7}.muted{fill:#a3a29b}.grid{stroke:#2c2c2a}.track{fill:#2c2c2a}.target{stroke:#c3c2b7}.good{stroke:#0ca30c}.warn{stroke:#fab219}.hist{fill:#1a1a19;stroke:#c3c2b7}}
</style>`

export const CHART_WIDTH = 380

/** The scorecard for the latest round against the target. */
export function scorecardSvg(rows: readonly LensRow[], target: number): string {
  const W = CHART_WIDTH, PAD = 12, PLOT = W - 2 * PAD, VALUE = 112
  const ROW = 44, BAR = 10, TOP = 30, BOTTOM = 26
  const H = TOP + Math.max(rows.length, 1) * ROW + BOTTOM
  const x = (score: number): number => r1(PAD + (Math.min(Math.max(score, 0), 10) / 10) * PLOT)
  const alt = scorecardAlt(rows, target)
  const top = (i: number): number => TOP + i * ROW
  const barY = (i: number): number => top(i) + 24
  const nameWidth = PLOT - VALUE - 8
  const parts: string[] = [
    STYLE,
    // The name column, so a name wider than estimated stops short of the verdict.
    `<defs><clipPath id="names"><rect x="0" y="0" width="${PAD + nameWidth}" height="${H}"/></clipPath></defs>`,
    `<rect class="bg" x="0" y="0" width="${W}" height="${H}" rx="6"/>`,
  ]

  // Under everything: the grid at 0, 5 and 10 and every track. Rules run beside the bars only, never
  // through a lens's name or verdict.
  const besideBars = (at: number, cls: string): string =>
    rows.map((_, i) => `<line class="${cls}" x1="${at}" x2="${at}" y1="${barY(i) - 4}" y2="${barY(i) + BAR + 4}"/>`).join('')
  for (const tick of [0, 5, 10]) {
    parts.push(besideBars(x(tick), 'grid'))
    parts.push(`<text class="muted small" x="${x(tick)}" y="${H - 8}" text-anchor="${tick === 0 ? 'start' : tick === 10 ? 'end' : 'middle'}">${tick}</text>`)
  }
  rows.forEach((_, i) => parts.push(`<rect class="track" x="${PAD}" y="${barY(i)}" width="${PLOT}" height="${BAR}" rx="2"/>`))

  // The target rule over the tracks and under the bars: a bar at the target ends exactly on it.
  const tx = x(target), anchor = tx > W - 50 ? 'end' : tx < 50 ? 'start' : 'middle'
  parts.push(besideBars(tx, 'target'))
  parts.push(`<line class="target" x1="${tx}" x2="${tx}" y1="${TOP - 6}" y2="${TOP - 1}"/>`)
  parts.push(`<text class="ink2 small" x="${tx}" y="${TOP - 10}" text-anchor="${anchor}">target ${formatScore(target)}</text>`)
  // A key for the rings, only when there are any, kept clear of the target's label (about 70px wide).
  if (rows.some(row => row.history.length)) {
    const labelLeft = anchor === 'end' ? tx - 70 : anchor === 'middle' ? tx - 35 : tx
    const kx = labelLeft > PAD + 120 ? PAD : W - PAD - 100
    parts.push(`<circle class="hist" cx="${kx + 4}" cy="${TOP - 14}" r="4"/>`)
    parts.push(`<text class="ink2 small" x="${kx + 13}" y="${TOP - 10}">earlier rounds</text>`)
  }

  rows.forEach((row, i) => {
    const { state, score } = row.latest
    const isAt = score !== null && score >= target
    const verdict = state === 'scored' ? `${formatScore(score!)}, ${isAt ? 'at' : 'below'} target ${formatScore(target)}` : stateWord(state)
    const was = row.history.length ? ` (earlier rounds: ${row.history.map(formatScore).join(' → ')})` : ''
    const value = state === 'scored' ? `${formatScore(score!)} · ${isAt ? '✓ at target' : '✗ below'}` : stateWord(state)
    parts.push(`<g><title>${esc(`${row.lens}: ${verdict}${was}`)}</title>`)
    parts.push(`<rect x="0" y="${top(i)}" width="${W}" height="${ROW}" fill="transparent"/>`)
    parts.push(`<text class="ink" x="${PAD}" y="${top(i) + 16}" clip-path="url(#names)">${esc(clipWidth(row.lens, nameWidth))}</text>`)
    parts.push(`<text class="${state === 'scored' ? 'ink' : 'ink2'}" x="${W - PAD}" y="${top(i) + 16}" text-anchor="end">${value}</text>`)
    if (state === 'scored' && score! > 0) {
      // Square at the baseline, 4px rounded at the data end.
      const y = barY(i), end = x(score!), r = r1(Math.min(4, (end - PAD) / 2, BAR / 2))
      parts.push(`<path class="${isAt ? 'good' : 'warn'}" d="M${PAD} ${y}H${r1(end - r)}A${r} ${r} 0 0 1 ${end} ${y + r}V${r1(y + BAR - r)}A${r} ${r} 0 0 1 ${r1(end - r)} ${y + BAR}H${PAD}Z"/>`)
    }
    // Earlier rounds over the bar, oldest faintest (never below 0.55): the ring fades, its fill stays solid.
    row.history.forEach((earlier, n) => {
      const opacity = (0.55 + (0.45 * (n + 1)) / row.history.length).toFixed(2)
      parts.push(`<circle class="hist" cx="${x(earlier)}" cy="${barY(i) + BAR / 2}" r="4" stroke-opacity="${opacity}"/>`)
    })
    parts.push('</g>')
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(alt)}">${parts.join('')}</svg>`
}

/** The chart's words, for a reader that cannot see it: the verdict first, then each lens with its own. */
export function scorecardAlt(rows: readonly LensRow[], target: number): string {
  const scored = rows.map(row => row.latest.score).filter((s): s is number => s !== null)
  const atTarget = scored.filter(s => s >= target).length, pending = rows.length - scored.length
  const summary = scored.length
    ? `${atTarget} of ${rows.length} at target ${formatScore(target)}, lowest ${pending ? 'so far ' : ''}${formatScore(Math.min(...scored))}${pending ? `, ${pending} not yet scored` : ''}`
    : `target ${formatScore(target)}`
  const each = rows.map(row => {
    const { score, state } = row.latest
    const now = score !== null ? `${formatScore(score)}, ${score >= target ? 'at' : 'below'} target` : state === 'running' ? 'reviewing' : stateWord(state)
    return `${row.lens}: ${now}${row.history.length ? ` (earlier ${row.history.map(formatScore).join(', ')})` : ''}`
  })

  return `Council scores: ${summary}. ${each.join('; ') || 'No reviewers yet'}.`
}
