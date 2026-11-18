/* Council: what a cycle means, with no engine calls. Ported from PandaCode's Council
 * (src-tauri/src/architect/council.rs and src/council.ts): rounds of independent reviewers,
 * a finish gate on the lowest score, and fixed lenses from round 1 on.
 * Derived from PandaCode, (c) 2026 PandaCode contributors, under the PandaCode License: see ../LICENSE. */
import type { CouncilConfig, CouncilCycle, CouncilDefaults, CouncilRound, CouncilSeat } from '../types'

export const REVIEWER_TYPE = 'council:reviewer'
export const MAX_SEATS = 8
export const MIN_REVIEWERS = 2
export const LENS_CHARS = 80
export const TARGETS = [7, 8, 8.5, 9, 9.5, 10] as const
export const ROUNDS = [3, 5, 10, 25] as const
/** 0 = Claude picks the reviewers for the work (at least 2). */
export const REVIEWERS = [0, 2, 3, 4, 5] as const
/** Tools whose run counts as a change to the work under review. */
export const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

export const DEFAULTS: CouncilDefaults = { target: 9, maxRounds: 10, reviewers: 0, isOnForNewSessions: false }
export const OFF: CouncilConfig = { isOn: false, target: 9, maxRounds: 10, reviewers: 0 }

export const emptyCycle = (since: number): CouncilCycle => ({
  since,
  changedAt: 0,
  rounds: [],
  isAccepted: false,
  lastBlock: null,
  isAsking: false,
})

/** The ranges Council takes (the pane offers a few; /council takes any value in range). */
export const validTarget = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= 10
export const validRounds = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 100
export const validReviewers = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= MAX_SEATS

/** Stored defaults, any value out of range read as the default. */
export function readDefaults(saved: unknown): CouncilDefaults {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<Record<keyof CouncilDefaults, unknown>>
  return {
    target: validTarget(s.target) ? s.target : DEFAULTS.target,
    maxRounds: validRounds(s.maxRounds) ? s.maxRounds : DEFAULTS.maxRounds,
    reviewers: validReviewers(s.reviewers) ? s.reviewers : DEFAULTS.reviewers,
    isOnForNewSessions: s.isOnForNewSessions === true,
  }
}

/** `1 round`, `10 rounds`. */
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** Every score and target has one decimal: 9.0, 9.5, 10.0. */
export const formatScore = (score: number): string => (Math.round(score * 10) / 10).toFixed(1)

/** The score in a report: the last line that starts (past markdown) with "Council score", read as the
 *  number after it, optionally `/10`. A number outside 0-10, or a line that does not read as one, is no score. */
export function parseScore(report: string): number | null {
  const LABEL = 'council score'
  const lines = report.split('\n')
  let rest: string | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').replace(/^[\s*#_>\-`~]*/, '')
    if (line.slice(0, LABEL.length).toLowerCase() === LABEL) {
      rest = line.slice(LABEL.length)
      break
    }
  }
  if (rest === null) return null
  rest = rest.replace(/^[\s:*_`=]*/, '')
  const number = /^(\d+)(\.\d+)?/.exec(rest)
  if (!number) return null
  const after = rest.slice(number[0].length)
  if (/^[\p{L}\p{N}]/u.test(after)) return null
  const tail = after.trimStart()
  if (tail.startsWith('/')) {
    const over = tail.slice(1).trimStart()
    if (!over.startsWith('10') || /^\d/.test(over.slice(2))) return null
  }
  // One decimal, as shown: a score never reads 9.0 while it counts as below a 9.0 target.
  const score = Math.round(Number(number[0]) * 10) / 10
  return Number.isFinite(score) && score >= 0 && score <= 10 ? score : null
}

export const lensKey = (lens: string): string => lens.trim().toLowerCase()
export const needed = (config: CouncilConfig): number => Math.max(config.reviewers, MIN_REVIEWERS)
/** A seat that counts toward its round: not abandoned, or scored (a score stands). */
export const counts = (seat: CouncilSeat): boolean => seat.state !== 'abandoned' || seat.score !== null
export const isLive = (seat: CouncilSeat): boolean => seat.state === 'running'

/** Round 1's lenses, from every seat it had, in first-seen order. */
export function fixedLenses(cycle: CouncilCycle): string[] {
  const first = cycle.rounds[0]
  if (!first) return []
  const seen = new Map<string, string>()
  for (const seat of first.seats) if (!seen.has(lensKey(seat.lens))) seen.set(lensKey(seat.lens), seat.lens.trim())
  return [...seen.values()]
}

export function lowest(round: CouncilRound): number | null {
  const scores = round.seats.filter(counts).map(seat => seat.score).filter((s): s is number => s !== null)
  return scores.length ? Math.min(...scores) : null
}

export const isStale = (cycle: CouncilCycle, round: CouncilRound): boolean => cycle.changedAt > round.startedAt
export const atLimit = (cycle: CouncilCycle, config: CouncilConfig): boolean => cycle.rounds.length >= config.maxRounds

/** The round-1 lenses that have not scored in this round. */
export function missingLenses(cycle: CouncilCycle, round: CouncilRound): string[] {
  const sat = new Set(round.seats.filter(seat => counts(seat) && seat.score !== null).map(seat => lensKey(seat.lens)))
  return fixedLenses(cycle).filter(lens => !sat.has(lensKey(lens)))
}

/** Complete: every seat that counts has a score and every round-1 lens sat. Round 1 also needs the
 *  reviewer count; later rounds seat exactly round 1's lenses, so a count changed mid-cycle never
 *  asks a later round for seats no lens may fill. */
export function isComplete(cycle: CouncilCycle, config: CouncilConfig, round: CouncilRound): boolean {
  const seats = round.seats.filter(counts)
  return seats.every(seat => seat.score !== null) && (round.number > 1 || seats.length >= needed(config)) && missingLenses(cycle, round).length === 0
}

/** Whether a round has room for one more lens: round 1 by the reviewer count, later rounds by round 1's lenses. */
function hasRoom(cycle: CouncilCycle, config: CouncilConfig, round: CouncilRound): boolean {
  const seats = round.seats.filter(counts)
  if (round.number > 1) return seats.length < fixedLenses(cycle).length

  return round.seats.length < MAX_SEATS && (config.reviewers === 0 || seats.length < config.reviewers)
}

/** A lens's reviewers that ended without a score in a round: past this many, Claude asks the person. */
export const MAX_FAILURES = 3
const failuresOf = (round: CouncilRound, key: string): number =>
  round.seats.filter(seat => lensKey(seat.lens) === key && seat.score === null && (seat.state === 'failed' || seat.note === REPLACED)).length
export const REPLACED = 'Replaced by a fresh reviewer.'

export const LIMIT_TEXT = 'The Council round limit is reached: make no more changes, finish, and say plainly which scores fell short.'

export type CouncilState = 'off' | 'accepted' | 'waiting' | 'reviewing' | 'dispatch' | 'asking' | 'fixing' | 'passed' | 'limit'
export type CouncilStatus = { state: CouncilState; round: number; lowest: number | null; target: number; isStale: boolean }

export function status(config: CouncilConfig, cycle: CouncilCycle): CouncilStatus {
  const latest = cycle.rounds.at(-1)
  const low = latest ? lowest(latest) : null
  const base = { round: latest?.number ?? 0, lowest: low, target: config.target, isStale: Boolean(latest && isStale(cycle, latest)) }
  if (!config.isOn) return { ...base, state: 'off' }
  if (cycle.isAccepted) return { ...base, state: 'accepted' }
  // Asking only while the refusal Claude stopped on still stands (a late score may have lifted it).
  if (cycle.isAsking && verdict(config, cycle)) return { ...base, state: 'asking' }
  if (!latest) return { ...base, state: 'waiting' }
  if (latest.seats.some(isLive)) return { ...base, state: 'reviewing' }
  // The last round must complete too: the limit stops new rounds opening, not this one finishing.
  if (!isComplete(cycle, config, latest)) return { ...base, state: 'dispatch' }
  if (!base.isStale && low !== null && low >= config.target) return { ...base, state: 'passed' }
  if (atLimit(cycle, config)) return { ...base, state: 'limit' }
  return { ...base, state: 'fixing' }
}

/** The state in words, for the band, the pane and the status line. */
export function stateText(config: CouncilConfig, cycle: CouncilCycle): string {
  const s = status(config, cycle)
  const of = ` of ${config.maxRounds}`
  const low = s.lowest === null ? null : formatScore(s.lowest)
  switch (s.state) {
    case 'off': return 'Off'
    case 'waiting': return cycle.changedAt ? 'Changes waiting for a council' : 'Waiting for changes to review'
    case 'reviewing': return `Round ${s.round}${of} · reviewing`
    case 'dispatch': return `Round ${s.round}${of} · waiting for Claude to seat reviewers`
    case 'asking': {
      // What Claude stopped on, from the refusal it was brought back for.
      const kind = verdict(config, cycle)?.key.split(':')[0]
      return kind === 'below' ? `Needs you: lowest ${low} below target ${formatScore(s.target)}`
        : kind === 'incomplete' ? `Needs you: round ${s.round} incomplete`
          : kind === 'stale' ? `Needs you: files changed after round ${s.round}`
            : kind === 'convene' ? 'Needs you: no council convened yet' : 'Needs you'
    }
    case 'fixing': return s.isStale && low !== null && s.lowest! >= s.target ? `Changed after passing at ${low}: re-review` : `Round ${s.round}${of} · fixing (lowest ${low})`
    case 'passed': return `Passed at ${low}`
    case 'accepted': return low === null ? 'Accepted' : `Accepted at ${low}`
    case 'limit': return `Stopped at round limit (${s.round}${of}): ${s.isStale ? 'files changed after the last round' : `lowest ${low} below target ${formatScore(s.target)}`}`
  }
}

/** Each lens's first score this cycle and its latest, in first-seen order. */
export function firstAndFinal(cycle: CouncilCycle): { lens: string; first: number; final: number }[] {
  const byLens = new Map<string, { lens: string; first: number; final: number }>()
  for (const round of cycle.rounds) for (const seat of round.seats) {
    if (seat.score === null) continue
    const key = lensKey(seat.lens), known = byLens.get(key)
    byLens.set(key, known ? { ...known, final: seat.score } : { lens: seat.lens.trim(), first: seat.score, final: seat.score })
  }
  return [...byLens.values()]
}

/** Whether the cycle still has work outstanding: a user message keeps it rather than starting a new one. */
export const isOutstanding = (config: CouncilConfig, cycle: CouncilCycle): boolean => {
  const refusal = verdict(config, cycle)

  return config.isOn && (cycle.rounds.some(round => round.seats.some(isLive)) || (refusal !== null && !refusal.isFinal))
}

export type Placement = { deny: string } | { round: number; isNew: boolean; replaces: string | null }

/** Where a newly dispatched reviewer sits, or why it may not. */
export function place(config: CouncilConfig, cycle: CouncilCycle, lens: string): Placement {
  const key = lensKey(lens), fixed = fixedLenses(cycle), latest = cycle.rounds.at(-1)
  if (!lens.trim()) return { deny: 'A Council reviewer needs a lens: set the Agent call\'s description to it (1-80 characters).' }
  if (cycle.isAccepted) return { deny: 'The user accepted the Council scores: convene no more reviewers. Verify, then finish with a table of each lens\'s first and final score.' }
  if (latest && !isStale(cycle, latest)) {
    // A replacement for a seat that ended without a score keeps that seat's round.
    const failed = latest.seats.find(seat => seat.state === 'failed' && seat.score === null && lensKey(seat.lens) === key)
    if (failed && failuresOf(latest, key) >= MAX_FAILURES) {
      return { deny: `The "${lens.trim()}" reviewer ended without a score ${MAX_FAILURES} times in Council round ${latest.number}: stop retrying, end your turn and tell the user, who can accept the scores or turn Council off.` }
    }
    if (failed) return { round: latest.number, isNew: false, replaces: failed.id }
    if (latest.seats.some(seat => counts(seat) && seat.state !== 'failed' && lensKey(seat.lens) === key) && !isComplete(cycle, config, latest)) {
      return { deny: `"${lens.trim()}" already sits in Council round ${latest.number}: each lens sits once per round.` }
    }
    if (!isComplete(cycle, config, latest) && hasRoom(cycle, config, latest)) {
      if (latest.number > 1 && !fixed.some(f => lensKey(f) === key)) return { deny: lensRefusal(fixed) }
      return { round: latest.number, isNew: false, replaces: null }
    }
    if (isComplete(cycle, config, latest)) {
      const low = lowest(latest)
      if (low !== null && low >= config.target) return { deny: `Council round ${latest.number} already passed at ${formatScore(low)} and nothing changed since. Verify and finish with the table of first and final scores.` }
      return { deny: `Council round ${latest.number} scored below the target and nothing changed since it started. Fix the blockers first, then convene a fresh round.` }
    }
    // Full and not complete: never skipped by opening the next round, which would re-roll its scores.
    if (latest.seats.some(isLive)) return { deny: `Council round ${latest.number} is full and its reviewers are still running: wait for their reports.` }
    const failedLenses = latest.seats.filter(seat => seat.state === 'failed' && seat.score === null).map(seat => seat.lens.trim())
    return { deny: `Council round ${latest.number} is full: seat again only a lens whose reviewer ended without a score${failedLenses.length ? ` (${failedLenses.join(', ')})` : ''}.` }
  }
  if (atLimit(cycle, config)) return { deny: `The Council round limit (${config.maxRounds}) is reached: make no more changes, finish, and say plainly which scores fell short.` }
  if (fixed.length && !fixed.some(f => lensKey(f) === key)) return { deny: lensRefusal(fixed) }
  return { round: (latest?.number ?? 0) + 1, isNew: true, replaces: null }
}
const lensRefusal = (fixed: string[]): string =>
  `Round 1 fixed the Council lenses: ${fixed.join(', ')}. Each sits again in every later round under its name, and no new lens joins. Use one of these as the description.`

/** Seats a reviewer as `place` decided. Opening a round over an incomplete one abandons its unscored seats. */
export function seat(cycle: CouncilCycle, placement: Exclude<Placement, { deny: string }>, add: CouncilSeat): CouncilCycle {
  let rounds = cycle.rounds.map(round => ({
    ...round,
    seats: round.seats.map(s =>
      s.id === placement.replaces ? { ...s, state: 'abandoned' as const, note: REPLACED }
        : placement.isNew && s.score === null && s.state !== 'abandoned' ? { ...s, state: 'abandoned' as const, note: `A new round opened before it scored.` }
          : s),
  }))
  if (placement.isNew) rounds = [...rounds, { number: placement.round, startedAt: add.createdAt, seats: [add] }]
  else rounds = rounds.map(round => (round.number === placement.round ? { ...round, seats: [...round.seats, add] } : round))
  return { ...cycle, rounds }
}

/** Applies a seat's report: its score, or a failure when it ended without one. */
export function settle(cycle: CouncilCycle, match: (seat: CouncilSeat) => boolean, report: string | null, failure?: string): CouncilCycle {
  return {
    ...cycle,
    rounds: cycle.rounds.map(round => ({
      ...round,
      seats: round.seats.map(s => {
        if (!match(s) || (s.state !== 'running' && s.state !== 'failed')) return s
        const score = report === null ? null : parseScore(report)
        // A report that arrives after its seat was marked failed still counts when it carries a score.
        if (s.state === 'failed' && score === null) return s
        return score !== null ? { ...s, score, state: 'scored' as const, note: null }
          : { ...s, state: 'failed' as const, note: failure ?? 'Ended without a `Council score: N/10` line.' }
      }),
    })),
  }
}

const ESCAPE = 'If a remaining blocker should not be fixed, end your turn and tell the user, who can lower the target or turn Council off (/council); if they say to accept the current scores, tell them to run /council accept or press Accept and finish in the Council pane (/council).'

/** A refusal of the finish gate. `key` names it, so the same one brings Claude back only once. A
 *  final one (the round limit) is said once and then lets Claude finish, never asking the person. */
export type Refusal = { key: string; text: string; isFinal?: true }

/** The finish gate: why Claude may not end its turn yet, or null. */
export function verdict(config: CouncilConfig, cycle: CouncilCycle): Refusal | null {
  if (!config.isOn || cycle.isAccepted) return null
  const latest = cycle.rounds.at(-1), target = formatScore(config.target)
  const count = config.reviewers ? `exactly ${config.reviewers}` : `at least ${MIN_REVIEWERS}`
  if (!latest) {
    if (!cycle.changedAt) return null
    return {
      key: `convene:${cycle.changedAt}`,
      text: `Council is on (target ${target}/10) and files changed this cycle, so convene a council before finishing: dispatch ${count} reviewers in one message with the Agent tool, subagent_type "${REVIEWER_TYPE}", each with a distinct lens as its description. Give each the user's goal and where the work is; never a target or prior scores.`,
    }
  }
  if (latest.seats.some(isLive)) return null
  const limit = atLimit(cycle, config)
  const final: Refusal = { key: `limit:${latest.number}`, text: LIMIT_TEXT, isFinal: true }
  if (!isComplete(cycle, config, latest)) {
    // Even at the limit: the last round must finish what it started.
    const failed = latest.seats.filter(s => s.state === 'failed' && s.score === null).map(s => s.lens)
    const missing = missingLenses(cycle, latest).filter(lens => !failed.some(f => lensKey(f) === lensKey(lens)))
    const scored = latest.seats.filter(s => counts(s) && s.score !== null).length
    const parts = [
      failed.length && `dispatch a fresh reviewer for each lens whose reviewer ended without a score (${failed.join(', ')})`,
      missing.length && `seat the round-1 lenses that have not sat yet (${missing.join(', ')})`,
      latest.number === 1 && scored + failed.length + missing.length < needed(config) && `seat ${count} reviewers in all`,
    ].filter(Boolean)
    return {
      // Not the seat count: a reviewer that fails again is the same refusal, so Claude then asks.
      key: `incomplete:${latest.number}:${scored}`,
      text: `Council round ${latest.number} is incomplete: ${parts.join('; ') || 'seat its remaining reviewers'}. Use the Agent tool with subagent_type "${REVIEWER_TYPE}" and the lens as the description.`,
    }
  }
  const low = lowest(latest)!
  const scores = latest.seats.filter(s => counts(s) && s.score !== null).map(s => `${s.lens.trim()} ${formatScore(s.score!)}`).join(', ')
  const lenses = fixedLenses(cycle).join(', ')
  if (isStale(cycle, latest)) {
    if (limit) return final
    return {
      key: `stale:${latest.number}:${cycle.changedAt}`,
      text: `Files changed after Council round ${latest.number} started, so its scores (${scores}) are out of date. Verify, then convene a fresh round with FRESH reviewers for the same lenses (${lenses}).`,
    }
  }
  if (low < config.target) {
    if (limit) return final
    return {
      key: `below:${latest.number}`,
      text: `Council round ${latest.number} of ${config.maxRounds}: the lowest score, ${formatScore(low)}/10, is below the target ${target}/10 (${scores}). The bar is every reviewer at the target, not the average. Read the reports, fix the real blockers, verify, then convene FRESH reviewers (new Agent calls, never SendMessage) for the same lenses (${lenses}). ${ESCAPE}`,
    }
  }
  return null
}

/** The lead's Council rules, given as context with a prompt whenever they change. Config values only. */
export function leadRules(config: CouncilConfig): string {
  const count = config.reviewers ? `exactly ${config.reviewers}` : `at least ${MIN_REVIEWERS}`
  return [
    '# Council',
    `Council is on, target ${formatScore(config.target)}/10, at most ${plural(config.maxRounds, 'round')}. Before you end a turn in which files changed, convene a council: independent read-only reviewers who each score the work out of 10.`,
    `- You decide the reviewers: distinct lenses that fit this work (correctness, security, UX, performance, visual quality, pacing, overall senior review, whatever matters here). Dispatch ${count} in ONE message, in parallel, with the Agent tool: subagent_type "${REVIEWER_TYPE}", description = the lens (1-${LENS_CHARS} characters), prompt = the user's goal, where the work is (files, commands, URLs) and what to inspect. Do it after your own edits are done. Giving reviewers different models (the Agent tool's model parameter) makes a stronger council.`,
    '- Never tell a reviewer prior scores or the score you want.',
    '- Round 1 fixes the lenses: each sits again in every later round under the same description, and no new lens joins later.',
    '- The bar is every reviewer at or above the target: the lowest score, not the average. After a round below it, read the reports, fix the real blockers, verify, and convene FRESH reviewers (new Agent calls; never SendMessage a reviewer).',
    `- Never finish below the target unless the limit of ${plural(config.maxRounds, 'round')} is reached; after the last round make no more changes, and say so plainly.`,
    `- ${ESCAPE}`,
    '- End your final message with a table of each lens\'s first and final score.',
    'A finish gate checks this when you stop and brings you back with what is left to do.',
  ].join('\n')
}

/** The reviewer's system prompt. It never carries the target or earlier scores. */
export const REVIEWER_PROMPT = [
  'You are an independent Council reviewer. Your lens is named at the top of your task.',
  'Hunt real defects and verify each by inspecting the work itself (code, output, frames, renders) or running checks; skip nitpicks that do not affect the result. Say what would raise the score. Score strictly: 10 means you found nothing worth improving; deduct for each real defect, in proportion to its impact.',
  'This is a read-only review. Do not change the work under review: do not edit, create, or delete files, or run commands that change the checkout; put any renders or builds outside it, such as in a temporary directory. Inspect the work your assignment names and report findings; do not fix them. Other agents may change files while you inspect them.',
  'End your final report with the exact line `Council score: N/10`, where N is your score from 0 to 10 (one decimal allowed).',
].join('\n\n')
