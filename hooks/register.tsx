/* Council for Claude Code, after PandaCode's Council (github.com/aicodeking/pandacode):
 * independent read-only reviewers score the work out of 10, and Claude may not end its turn
 * until every reviewer of a current round reaches the target (the lowest score, not the average),
 * the round limit is reached, or the person accepts the scores. */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CouncilConfig, CouncilCycle, CouncilRound, CouncilSeat } from '../types'
import {
  LIMIT_TEXT, OFF, REPLACED, REVIEWERS, REVIEWER_PROMPT, REVIEWER_TYPE, ROUNDS, TARGETS, WRITE_TOOLS, LENS_CHARS,
  counts, emptyCycle, firstAndFinal, formatScore, isComplete, isLive, isOutstanding, isStale, leadRules, plural, lowest, parseScore, place,
  readDefaults, seat as seatIn, settle, stateText, status, validReviewers, validRounds, validTarget, verdict,
} from './logic'
import { graphemes, lensRows, scorecardAlt, scorecardSvg, stateWord, type LensRow } from './chart'
import type { CouncilState } from './logic'

const PANE = 'council'
/** Prompt origins that are no request of their own: a background task's notice and a plugin's prompt (this
 *  mod's wake-ups among them). Every other prompt is a request, and may start a new cycle. */
const NOT_REQUESTS = new Set(['task-notification', 'plugin'])
const TITLE = 'Council'
// Change a tag when that value's fields change: it declines what an earlier version stored.
const configAtom = atom({ plugin: 'council', key: 'config' } as const, null, { shape: 'config-1' })
const cycleAtom = atom({ plugin: 'council', key: 'cycle' } as const, emptyCycle(0), { shape: 'cycle-1' })
const newSessionsAtom = atom({ plugin: 'council', key: 'isOnForNewSessions' } as const, false)
/** Whether the main loop is mid-turn: state, so a hot reload mid-turn keeps it. */
const workingAtom = atom({ plugin: 'council', key: 'isWorking' } as const, false)
/** The Council rules the lead was last given ('' for none). They ride along with a prompt as context
 *  whenever they change, so a setting changed mid-thread reaches the lead (a system prompt section would
 *  not: a thread keeps the system prompt it started with); a compaction or a new conversation forgets them. */
const rulesAtom = atom({ plugin: 'council', key: 'rulesKnown' } as const, '')

type $ = EngineInterface

const USAGE = [
  '/council                 open the Council pane',
  '/council on | off        turn Council on or off for this session',
  '/council target 9.5      the score every reviewer must reach (1-10)',
  '/council rounds 10       rounds a cycle may start (1-100)',
  '/council reviewers 3     reviewers per round (2-8), or: /council reviewers auto',
  '/council accept          accept the current scores and let Claude finish',
  '/council new on | off    start new sessions with Council on or off',
  '/council status          the current round and scores',
].join('\n')

const getConfig = async ($: $): Promise<CouncilConfig> => (await read($, configAtom)) ?? OFF

const abandonLive = (cycle: CouncilCycle, note: string): CouncilCycle => ({
  ...cycle,
  rounds: cycle.rounds.map(round => ({
    ...round,
    seats: round.seats.map(s => (s.state === 'running' ? { ...s, state: 'abandoned' as const, note } : s)),
  })),
})

/** The agents of the seats still running whose agent is known: the reviewers abandonLive marks stopped. A
 *  seat whose agent is still starting has none yet; the spawn hook stops that agent once it has an id. */
const liveAgents = (cycle: CouncilCycle): string[] =>
  cycle.rounds.flatMap(r => r.seats.flatMap(s => (s.state === 'running' && s.agentId ? [s.agentId] : [])))

/** The agents of seats running in `before` that `after` abandoned: a new round opening over them. */
const abandonedAgents = (before: CouncilCycle, after: CouncilCycle): string[] => {
  const ended = new Set(after.rounds.flatMap(r => r.seats.filter(s => s.state === 'abandoned').map(s => s.id)))

  return before.rounds.flatMap(r => r.seats.flatMap(s => (s.state === 'running' && s.agentId && ended.has(s.id) ? [s.agentId] : [])))
}

/** Stops reviewers whose scores no longer count, so they spend nothing more. Sent apart from the caller,
 *  as a wake-up is, so a command never waits on it. One that cannot be stopped (already ended, or the stop
 *  refused) runs on, and its score is not counted. */
function stopReviewers($: $, agentIds: readonly string[]): void {
  if (agentIds.length === 0) return
  $.clock.after(0, async () => {
    await Promise.all(agentIds.map(id => $.tool.call({ tool: 'TaskStop', task_id: id }).catch(() => undefined)))
  })
}

/** A round's seats as shown: those that count, and those stopped before they scored (not the ones a
 *  fresh reviewer replaced). */
const shownSeats = (round: CouncilRound): CouncilSeat[] => round.seats.filter(s => counts(s) || s.note !== REPLACED)

const seatText = (seat: CouncilSeat): string =>
  `${seat.lens.trim()} ${seat.score !== null ? formatScore(seat.score) : seat.state === 'running' ? '…' : seat.state === 'failed' ? 'no score' : 'stopped'}`

/** A round in one line, or nothing for a round with no seat to show. */
function roundLine(round: CouncilRound): string | null {
  const seats = shownSeats(round), low = lowest(round)
  if (!seats.length) return null

  return `Round ${round.number}${low === null ? '' : ` · lowest ${formatScore(low)}`}: ${seats.map(seatText).join(' · ')}`
}

/** The state's tone: success once passed or accepted, warning while below the target. */
const toneOf = (state: CouncilState): 'success' | 'warning' | undefined =>
  state === 'passed' || state === 'accepted' ? 'success' : state === 'asking' || state === 'fixing' || state === 'limit' ? 'warning' : undefined

/** A lens's latest score in words, with its verdict against the target. */
const rowValue = (row: LensRow, target: number): string =>
  row.latest.score !== null ? `${formatScore(row.latest.score)} ${row.latest.score >= target ? '✓ at target' : `✗ below ${formatScore(target)}`}`
    : stateWord(row.latest.state)

/** A lens's bar color: success at the target, warning below it, none without a score. */
const rowTone = (row: LensRow, target: number): 'success' | 'warning' | undefined =>
  row.latest.score === null ? undefined : row.latest.score >= target ? 'success' : 'warning'

const isWideCode = (code: number): boolean =>
  (code >= 0x1100 && code <= 0x115f) || (code >= 0x231a && code <= 0x231b) || (code >= 0x2e80 && code <= 0x303e) || (code >= 0x3041 && code <= 0x33ff)
  || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xa000 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
  || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
  || (code >= 0x1f300 && code <= 0x1f64f) || (code >= 0x1f900 && code <= 0x1f9ff) || (code >= 0x20000 && code <= 0x3fffd)

/** A grapheme's width in terminal cells, measured as Ink measures text: an emoji takes two, East Asian
 *  wide and fullwidth characters two each, controls and combining diacritics none, everything else one
 *  per code point (so ✓ and ✗ take one, ✅ and ⚡ two, and an Indic syllable one per code point). */
const cellsOf = (grapheme: string): number => {
  if (/\p{Emoji_Presentation}|️|⃣/u.test(grapheme) && /\p{Extended_Pictographic}|⃣/u.test(grapheme)) return 2
  let cells = 0
  for (const char of grapheme) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0x300 && code <= 0x36f) || code === 0x200b) continue
    cells += isWideCode(code) ? 2 : 1
  }

  return cells
}
const cellWidth = (text: string): number => graphemes(text).reduce((sum, g) => sum + cellsOf(g), 0)

/** A 0-10 score as a bar of `width` cells, with the target marked ┃ so "just below" reads at a glance. */
const textBar = (score: number | null, width: number, target: number): string => {
  const filled = score === null ? 0 : Math.round((Math.min(Math.max(score, 0), 10) / 10) * width)
  const cells: string[] = Array.from({ length: width }, (_, i) => (i < filled ? '█' : '░'))
  cells[Math.min(width - 1, Math.max(0, Math.round((target / 10) * width) - 1))] = '┃'

  return cells.join('')
}

/** Text in exactly `width` cells: clipped by whole graphemes with an ellipsis, else padded. */
const clipPad = (text: string, width: number): string => {
  const total = cellWidth(text)
  if (total <= width) return text + ' '.repeat(width - total)
  let used = 0, out = ''
  for (const g of graphemes(text)) {
    if (used + cellsOf(g) > width - 1) break
    used += cellsOf(g)
    out += g
  }

  return `${out}…${' '.repeat(Math.max(0, width - used - 1))}`
}

/** "2 of 10 rounds used", or past a lowered limit "3 rounds used (limit 2)". */
const roundsUsed = (cycle: CouncilCycle, config: CouncilConfig): string =>
  cycle.rounds.length > config.maxRounds ? `${plural(cycle.rounds.length, 'round')} used (limit ${config.maxRounds})` : `${cycle.rounds.length} of ${plural(config.maxRounds, 'round')} used`

function report(config: CouncilConfig, cycle: CouncilCycle): string {
  const lines = [
    `Council: ${stateText(config, cycle)}`,
    `Settings: ${config.isOn ? 'on' : 'off'} · target ${formatScore(config.target)} · ${plural(config.maxRounds, 'round')} · ${config.reviewers ? `${config.reviewers} reviewers` : 'auto reviewers'}`,
  ]
  for (const round of cycle.rounds) {
    const line = roundLine(round)
    if (line) lines.push(line)
  }
  const table = firstAndFinal(cycle)
  if (cycle.rounds.length > 1 && table.length) lines.push(`First → final: ${table.map(t => `${t.lens} ${formatScore(t.first)} → ${formatScore(t.final)}`).join(' · ')}`)
  return lines.join('\n')
}

/** Whether the Stop gate ran in the main loop's current turn: a plugin above it may pass it by, and
 *  then the gate speaks at the turn's end instead. A reload mid-turn starts it over, which at worst
 *  asks the gate once more at that turn's end, where the same refusal then reads as asking. */
let stopRan = false
/** Writes of the saved defaults, one after another, so two changes at once both reach the store. */
let storeQueue: Promise<void> = Promise.resolve()

const isBusy = async ($: $): Promise<boolean> => read($, workingAtom)

/** The finish gate: the refusal Claude must act on before it ends its turn, or null. The same refusal
 *  brings Claude back once; stopping on it again means Claude is asking the person, except for the round
 *  limit's final word, said once, after which Claude finishes. */
async function gate($: $): Promise<string | null> {
  const config = await getConfig($), cycle = await read($, cycleAtom)
  const refusal = verdict(config, cycle)
  if (!refusal || (refusal.isFinal && cycle.lastBlock === refusal.key)) {
    if (cycle.isAsking || (cycle.lastBlock && !refusal)) await update($, cycleAtom, c => ({ ...c, isAsking: false, lastBlock: refusal ? c.lastBlock : null }))
    await refresh($)

    return null
  }
  if (cycle.lastBlock === refusal.key) {
    await update($, cycleAtom, c => ({ ...c, isAsking: true }))
    await refresh($)
    $.ui.toast(`Council: ${stateText(config, { ...cycle, isAsking: true })}. Reply, change the target, or /council accept.`, { timeoutMs: 8000 })

    return null
  }
  await update($, cycleAtom, c => ({ ...c, lastBlock: refusal.key, isAsking: false }))
  await refresh($)

  return refusal.text
}

async function refresh($: $): Promise<void> {
  const config = await getConfig($)
  $.ui.status(config.isOn ? `Council ${formatScore(config.target)}: ${stateText(config, await read($, cycleAtom))}` : undefined)
}

type Wake = { text: string; refusalKey?: string | undefined }

/** Wakes Claude with a prompt, from a moment after this event (a command's own run may not submit a
 *  prompt: it would wait on the turn the command holds). What it says is worked out when it is sent, so a
 *  later change in the meantime wins. An idle Claude only, unless `evenIfBusy`: then the prompt waits for
 *  the running turn to end. A `refusalKey` marks that refusal as brought back once, undone if the prompt
 *  was dropped. A reload in the 250ms between drops the wake-up; the state it would follow stays. */
function wake($: $, build: () => Promise<Wake | null>, evenIfBusy = false): void {
  $.clock.after(250, async () => {
    if (!evenIfBusy && (await isBusy($))) return
    const message = await build()
    if (!message) return
    const key = message.refusalKey
    let before: string | null = null
    if (key) await update($, cycleAtom, c => ((before = c.lastBlock), { ...c, lastBlock: key }))
    const sent = await $.prompt.submit({ text: message.text }).catch(() => ({ drop: 'failed' as const }))
    if (key && 'drop' in sent && sent.drop) await update($, cycleAtom, c => (c.lastBlock === key ? { ...c, lastBlock: before } : c))
  })
}

const FINISH = 'Verify, then finish with a table of each lens\'s first and final score.'

/** What Claude is to do next: the refusal that stands, else what the cycle's state calls for. */
function nextStep(config: CouncilConfig, cycle: CouncilCycle): Wake {
  if (!config.isOn) return { text: 'Council is off now. Finish your work as usual.' }
  const refusal = verdict(config, cycle)
  if (refusal) return { text: refusal.text, refusalKey: refusal.key }
  const state = status(config, cycle).state
  if (state === 'limit') return { text: LIMIT_TEXT }
  if (state === 'passed') return { text: `Every reviewer is at the target (${formatScore(config.target)}/10). ${FINISH}` }
  if (!cycle.rounds.some(r => r.seats.some(s => s.score !== null))) return { text: 'Verify, then finish.' }

  return { text: FINISH }
}

/** Writes fields of the saved defaults, after any write before it. */
function writeDefaults($: $, fields: Record<string, unknown>): Promise<void> {
  storeQueue = storeQueue.then(async () => {
    await $.store.set('defaults', { ...readDefaults(await $.store.get('defaults')), ...fields })
  }).catch(() => undefined)

  return storeQueue
}

/** Saves as defaults the fields this change set, and no others: a one-off value set earlier stays out. */
async function saveDefaults($: $, patch: Partial<CouncilConfig>): Promise<void> {
  const fields: Record<string, number> = {}
  if (patch.target !== undefined) fields.target = patch.target
  if (patch.maxRounds !== undefined) fields.maxRounds = patch.maxRounds
  if (patch.reviewers !== undefined) fields.reviewers = patch.reviewers
  if (Object.keys(fields).length) await writeDefaults($, fields)
}

const sameConfig = (a: CouncilConfig, b: CouncilConfig): boolean =>
  a.isOn === b.isOn && a.target === b.target && a.maxRounds === b.maxRounds && a.reviewers === b.reviewers

/** Changes a setting. Unless `isOneOff` (the pane's Lower target and Raise limit, which unstick one task),
 *  what it sets becomes the default. Turning Council on while Claude is idle starts a fresh cycle (it
 *  reviews what comes next), and so does a new target or reviewer count after a cycle passed (the next
 *  work is held to it, not the work that passed). A change that ends Claude's asking, or raises the limit
 *  a cycle stopped at, wakes it once: only the change that clears the asking wakes, so two at once wake once. */
async function setConfig($: $, patch: Partial<CouncilConfig>, isOneOff = false): Promise<void> {
  const now = await $.clock.now(), busy = await isBusy($)
  // Applied to the value as it stands when written, so two changes at once both land.
  let before: CouncilConfig = OFF, after: CouncilConfig = OFF
  await update($, configAtom, current => {
    before = current ?? OFF
    after = { ...before, ...patch }

    return after
  })
  if (sameConfig(before, after)) return
  if (!isOneOff) await saveDefaults($, patch)
  if (after.isOn && !before.isOn && !busy) await update($, cycleAtom, () => emptyCycle(now))
  if (!after.isOn && before.isOn) {
    let live: string[] = []
    await update($, cycleAtom, c => ((live = liveAgents(c)), abandonLive(c, 'Stopped: Council was turned off.')))
    stopReviewers($, live)
  }
  const raisesBar = after.target !== before.target || after.reviewers !== before.reviewers
  if (before.isOn && after.isOn && raisesBar) await update($, cycleAtom, c => (status(before, c).state === 'passed' ? emptyCycle(now) : c))
  let wasAsking = false, stateBefore = 'off' as CouncilState
  await update($, cycleAtom, c => {
    wasAsking = c.isAsking
    stateBefore = status(before, c).state

    return c.isAsking ? { ...c, isAsking: false, lastBlock: null } : c
  })
  if (wasAsking && !busy) {
    wake($, async () => {
      const step = nextStep(await getConfig($), await read($, cycleAtom))
      return { ...step, text: `The user changed the Council settings. ${step.text}` }
    })
  } else if (!wasAsking && !busy && before.isOn && after.isOn && stateBefore === 'limit' && after.maxRounds > before.maxRounds) {
    // A raised round limit reopens a cycle that stopped at the limit below the target.
    wake($, async () => {
      const refusal = verdict(await getConfig($), await read($, cycleAtom))
      return refusal && !refusal.isFinal ? { text: `The user raised the Council round limit. ${refusal.text}`, refusalKey: refusal.key } : null
    })
  }
  await refresh($)
}

/** Accepts this cycle's scores: the gate lets Claude finish and no more reviewers are seated. Claude is told
 *  once, at once if idle, else when its running turn ends. */
async function accept($: $): Promise<string> {
  const config = await getConfig($)
  if (!config.isOn) return 'Council is off.'
  let already = false, lifted = false, scored = false, live: string[] = []
  await update($, cycleAtom, c => {
    already = c.isAccepted
    scored = c.rounds.some(r => r.seats.some(s => s.score !== null))
    lifted = !c.isAccepted && (verdict(config, c) !== null || c.isAsking || c.rounds.some(r => r.seats.some(isLive)))
    live = c.isAccepted ? [] : liveAgents(c)

    return c.isAccepted ? c : { ...abandonLive(c, 'Stopped: the user accepted the Council scores.'), isAccepted: true, isAsking: false, lastBlock: null }
  })
  if (already) return 'The Council scores are already accepted.'
  stopReviewers($, live)
  await refresh($)
  const busy = await isBusy($)
  const text = scored
    ? `The user accepted the current Council scores: convene no more reviewers. ${FINISH}`
    : 'The user chose to finish without a Council review: convene no reviewers. Verify, then finish.'
  if (lifted || busy) wake($, async () => ({ text }), true)

  return `Council ${scored ? 'scores accepted' : 'review skipped'}: Claude ${busy ? 'finishes once its current step ends' : 'may finish now'}.`
}

/** Keep fixing: the person answers Claude's question by sending it back to what the refusal asks. A press
 *  that finds Claude no longer asking (a second press, the band and the pane both) does nothing. */
async function keepFixing($: $): Promise<void> {
  let wasAsking = false
  await update($, cycleAtom, c => {
    wasAsking = c.isAsking

    return c.isAsking ? { ...c, isAsking: false, lastBlock: null } : c
  })
  if (!wasAsking) return
  wake($, async () => {
    const step = nextStep(await getConfig($), await read($, cycleAtom))
    return { ...step, text: `Keep going. ${step.text}` }
  })
  await refresh($)
}

/** The kind of refusal Claude stopped on: below, stale, incomplete, convene or limit. */
const refusalKind = (config: CouncilConfig, cycle: CouncilCycle): string | undefined => verdict(config, cycle)?.key.split(':')[0]

/** What Claude's question is about, from the refusal it stopped on (never from the scores alone). */
function askingNotice(config: CouncilConfig, cycle: CouncilCycle): string {
  const s = status(config, cycle)
  switch (refusalKind(config, cycle)) {
    case 'below': return `Claude is asking how to continue: the lowest score, ${formatScore(s.lowest ?? 0)}, is below your target of ${formatScore(config.target)}.`
    case 'incomplete': return `Claude stopped with round ${s.round} incomplete and is asking how to continue.`
    case 'stale': return `Files changed after round ${s.round} started, and Claude stopped before a fresh round.`
    case 'convene': return 'Files changed, and Claude stopped without convening a council.'
    default: return 'Claude is asking how to continue.'
  }
}

/** The button that sends Claude back, named for what it will do. */
const goOnLabel = (config: CouncilConfig, cycle: CouncilCycle): string => {
  const kind = refusalKind(config, cycle)

  return kind === 'convene' ? 'Convene reviewers' : kind === 'incomplete' ? 'Seat the missing reviewers' : kind === 'stale' ? 'Review again' : 'Keep fixing'
}

/** The accept button, named for what it does: accept scores, or skip a review nothing has scored in. */
const acceptLabel = (cycle: CouncilCycle): string =>
  cycle.rounds.some(r => r.seats.some(s => s.score !== null)) ? 'Accept and finish' : 'Skip review and finish'

/** Whether the person can accept now: Council has something it would hold Claude to. */
const canAcceptIn = (config: CouncilConfig, cycle: CouncilCycle): boolean => {
  const state = status(config, cycle).state

  return config.isOn && !cycle.isAccepted && (verdict(config, cycle) !== null || ['asking', 'reviewing', 'dispatch', 'fixing'].includes(state))
}

/** Applies reviewers' reports and says each new score aloud, once, however many events carry the report. */
async function settleSeats($: $, match: (seat: CouncilSeat) => boolean, text: string | null, failure?: string): Promise<void> {
  let changed: CouncilSeat[] = []
  await update($, cycleAtom, c => {
    const next = settle(c, match, text, failure)
    const was = new Map(c.rounds.flatMap(r => r.seats).map(s => [s.id, s]))
    changed = next.rounds.flatMap(r => r.seats).filter(s => {
      const old = was.get(s.id)
      return old !== undefined && (old.state !== s.state || old.score !== s.score)
    })

    return next
  })
  if (!changed.length) return
  const config = await getConfig($)
  $.ui.toast(`Council: ${changed.map(s => (s.score !== null ? `${s.lens.trim()} scored ${formatScore(s.score)} (target ${formatScore(config.target)})` : `${s.lens.trim()} ended without a score`)).join(' · ')}`)
  await refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'council',
      description: 'Council: reviewers score the work until all reach your target',
      argumentHint: '[on|off|accept|status|target N|rounds N|reviewers N|auto|new on|off]',
    })
    try {
      await $.agent.register({
        name: 'reviewer',
        description: 'Independent read-only Council reviewer that scores the work out of 10 through one lens. Use only while Council is on, with the lens as the description.',
        prompt: REVIEWER_PROMPT,
        disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Agent'],
      })
    } catch (error) {
      $.ui.log(`council: the reviewer agent type was not registered: ${String(error)}`)
    }
    const defaults = readDefaults(await $.store.get('defaults'))
    await update($, newSessionsAtom, () => defaults.isOnForNewSessions)
    if ((await read($, configAtom)) === null) {
      const now = await $.clock.now()
      await update($, configAtom, () => ({ isOn: defaults.isOnForNewSessions, target: defaults.target, maxRounds: defaults.maxRounds, reviewers: defaults.reviewers }))
      await update($, cycleAtom, () => emptyCycle(now))
    }
    await refresh($)

    return started
  })

  on('session.end', async ($, e, next) => {
    // A /clear or a /resume moves to another conversation: its council starts over, and the rules go again.
    if (e.reason === 'clear' || e.reason === 'resume') {
      const now = await $.clock.now()
      await update($, cycleAtom, () => emptyCycle(now))
      await update($, rulesAtom, () => '')
      await refresh($)
    }

    return next(e)
  })

  // A compaction may summarise away the prompt the rules rode with: they go again with the next one.
  on('classic.PostCompact', async ($, e, next) => {
    await update($, rulesAtom, () => '')

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta || e.command) return next(e)
    const config = await getConfig($)
    // A request (the person's message, a scheduled task, a channel or another session; not a task's notice
    // or a plugin's prompt, this mod's wake-ups included) starts a new cycle, but only when the old one has
    // nothing outstanding, so "keep going" after a stop continues its rounds.
    if (!NOT_REQUESTS.has(e.origin.kind)) {
      const now = await $.clock.now()
      await update($, cycleAtom, c => (isOutstanding(config, c) ? { ...c, lastBlock: null, isAsking: false } : emptyCycle(now)))
      await refresh($)
    }
    // The rules ride along with the prompt whenever they differ from what the lead was last given.
    const wanted = config.isOn ? leadRules(config) : ''
    let note: string | null = null
    await update($, rulesAtom, known => {
      note = wanted === known ? null : wanted || 'Council is off now: the Council rules given earlier no longer apply.'

      return wanted
    })
    if (note) return next({ ...e, context: [...(e.context ?? []), note] })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      stopRan = false
      await update($, workingAtom, () => true)
      // Working again: whatever woke Claude answered its question. The bring-back stays spent.
      await update($, cycleAtom, c => (c.isAsking ? { ...c, isAsking: false } : c))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, workingAtom, () => false)
      // The Stop gate was passed by: speak at the turn's end instead, once the turn has settled.
      if (e.reason === 'answer') {
        $.clock.after(250, async () => {
          if (stopRan || (await isBusy($))) return
          const refusal = await gate($)
          if (refusal && !(await isBusy($))) await $.prompt.submit({ text: `Council: ${refusal}` }).catch(() => undefined)
        })
      }
    } else {
      const agentId = e.agentId
      await settleSeats($, s => s.agentId === agentId, e.isAborted ? null : e.answer, e.isAborted ? 'Interrupted before it scored.' : undefined)
    }

    return next(e)
  })

  // Seats each reviewer in its round, or refuses it with what to do instead.
  on('agent.spawn', async ($, e, next) => {
    if (e.subagentType !== REVIEWER_TYPE) return next(e)
    const config = await getConfig($)
    if (!config.isOn) return { deny: 'Council is off: council:reviewer only sits in a Council round. The user can turn Council on with /council on.' }
    if (e.parentAgentId) return { deny: 'Only the main conversation convenes a council; a subagent cannot.' }
    // One line of text: line breaks would break the band, the pane's rows and the table.
    const lens = Array.from(e.description.replace(/\s+/g, ' ').trim()).slice(0, LENS_CHARS).join(''), now = await $.clock.now()
    const seat: CouncilSeat = { id: e.tool_use_id, agentId: null, lens, score: null, state: 'running', note: null, createdAt: now }
    let denied: string | null = null, overtaken: string[] = []
    await update($, cycleAtom, c => {
      const placement = place(config, c, lens)
      denied = 'deny' in placement ? placement.deny : null
      if ('deny' in placement) return c
      const after = seatIn(c, placement, seat)
      overtaken = abandonedAgents(c, after)

      return after
    })
    if (denied !== null) return { deny: denied }
    // A new round opened over reviewers still running: their scores no longer count.
    stopReviewers($, overtaken)
    await refresh($)
    const spawned = await next({ ...e, prompt: `Your Council lens: ${lens}.\n\n${e.prompt}` })
    if (spawned.deny !== undefined) {
      await update($, cycleAtom, c => ({ ...c, rounds: c.rounds.map(r => ({ ...r, seats: r.seats.filter(s => s.id !== seat.id) })).filter(r => r.seats.length) }))
    } else if (spawned.agentId) {
      const agentId = spawned.agentId
      let wasAbandoned = false
      await update($, cycleAtom, c => ({
        ...c,
        rounds: c.rounds.map(r => ({ ...r, seats: r.seats.map(s => (s.id === seat.id ? ((wasAbandoned = s.state === 'abandoned'), { ...s, agentId }) : s)) })),
      }))
      // Accepted, turned off or overtaken while it started: stopped now that it has an id.
      if (wasAbandoned) stopReviewers($, [agentId])
    }
    await refresh($)

    return spawned
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    // A reviewer is never followed up: the next round uses fresh reviewers, who never see earlier scores.
    if (e.tool === 'SendMessage') {
      const to = String(e.to ?? ''), cycle = await read($, cycleAtom)
      if (to && cycle.rounds.some(r => r.seats.some(s => s.agentId === to))) {
        return { deny: 'A Council reviewer is never followed up: dispatch a fresh reviewer for the next round.' }
      }
    }
    const ran = await next(e)
    if (WRITE_TOOLS.has(String(e.tool)) && ran.deny === undefined && !ran.isError) {
      const now = await $.clock.now()
      await update($, cycleAtom, c => ({ ...c, changedAt: now }))
      await refresh($)
    }
    if (e.tool === 'Agent' && e.subagent_type === REVIEWER_TYPE) {
      const id = e.tool_use_id
      if (ran.deny !== undefined || ran.isError) await settleSeats($, s => s.id === id, null, `The Agent call failed: ${(ran.deny ?? ran.text ?? '').slice(0, 200)}`)
      else if (ran.text && parseScore(ran.text) !== null) await settleSeats($, s => s.id === id, ran.text)
      else {
        // Launched in the background (its turn.complete settles it), or ended without a score. Only an
        // agent the session lists as ended counts as the latter: one not listed yet is still starting.
        const seat = (await read($, cycleAtom)).rounds.flatMap(r => r.seats).find(s => s.id === id)
        const agent = seat?.agentId ? (await $.agent.list()).find(a => a.id === seat.agentId) : undefined
        if (seat && agent && ['completed', 'failed', 'killed'].includes(agent.status)) await settleSeats($, s => s.id === id, ran.text ?? '')
      }
    }

    return ran
  }).catch(($, e, next) => next(e))

  // The finish gate: Claude may not end its turn while Council refuses. The same refusal brings it
  // back once; stopping on it again means Claude is asking the person.
  on('classic.Stop', async ($, e, next) => {
    stopRan = true
    const beneath = await next(e)
    const refusal = await gate($)
    if (!refusal) return beneath

    return { ...beneath, block: beneath.block ? `${beneath.block}\n\n${refusal}` : refusal }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'council' }, async ($, e) => {
    const [word = '', value = ''] = e.args.trim().toLowerCase().split(/\s+/)
    const config = await getConfig($)
    const say = async (head: string) => ({ text: `${head}\n${report(await getConfig($), await read($, cycleAtom))}` })
    switch (word) {
      case '': {
        const { isPlaced } = await $.ui.open({ id: PANE, title: TITLE })
        return say(isPlaced ? 'Council pane opened.' : 'This surface shows no pane; the Council\'s state is below.')
      }
      case 'on': {
        if (config.isOn) return say('Council is already on.')
        await setConfig($, { isOn: true })
        // Unasked, the pane opens only where it docks as a sidebar (fullscreen, 110 columns or more),
        // never inline over the conversation.
        const isDocked = e.presentation.isFullscreen && e.presentation.columns >= 110
        const isPlaced = isDocked && (await $.ui.open({ id: PANE, title: TITLE })).isPlaced
        const when = (await isBusy($)) ? 'it reviews this request\'s changes' : 'it reviews what Claude changes from your next message on'
        return say(`Council is on: ${when}.${isPlaced ? '' : ' Open its pane with /council.'}`)
      }
      case 'off':
        await setConfig($, { isOn: false })
        return { text: 'Council is off.' }
      case 'accept':
        return { text: await accept($) }
      case 'status':
        return { text: report(config, await read($, cycleAtom)) }
      case 'target': {
        const n = Math.round(Number(value) * 10) / 10
        if (!validTarget(n)) return { text: 'The Council target is between 1 and 10, e.g. /council target 9.5' }
        await setConfig($, { target: n })
        return say(`Council target set to ${formatScore(n)}.`)
      }
      case 'rounds': {
        const n = Number(value)
        if (!validRounds(n)) return { text: 'Council takes 1 to 100 rounds, e.g. /council rounds 10' }
        await setConfig($, { maxRounds: n })
        return say(`Council round limit set to ${n}.`)
      }
      case 'auto':
      case 'reviewers': {
        const n = word === 'auto' || value === 'auto' ? 0 : Number(value)
        if (!validReviewers(n) || n === 1) return { text: 'Council seats 2 to 8 reviewers per round, or auto: /council reviewers 3' }
        await setConfig($, { reviewers: n })
        return say(n ? `Council seats exactly ${n} reviewers per round.` : 'Claude picks the reviewers for the work (at least 2).')
      }
      case 'new': {
        const isOn = value === 'on'
        if (value !== 'on' && value !== 'off') return { text: 'Use /council new on or /council new off.' }
        await update($, newSessionsAtom, () => isOn)
        await writeDefaults($, { isOnForNewSessions: isOn })
        return { text: `New sessions start with Council ${isOn ? 'on' : 'off'}.` }
      }
      default:
        return { text: USAGE }
    }
  })

  // One row above the prompt, always there but under a survey, so the pane is one press away. With
  // nothing to report (off, or on with no changes yet) the row is short: on or off, and the button.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const config = await getConfig($)
    const cycle = await read($, cycleAtom), s = status(config, cycle)
    const { Box, Button, Text } = $.ui.resolve(e)
    if (!config.isOn || (s.state === 'waiting' && !cycle.changedAt)) {
      return (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Text bold dimColor>Council</Text>
          <Text dimColor>{config.isOn ? `On · target ${formatScore(config.target)}` : 'Off'}</Text>
          <Button key="open" label="Council…" onPress={() => $.ui.open({ id: PANE, title: TITLE })} />
        </Box>
      )
    }
    const latest = cycle.rounds.at(-1)
    const seats = latest ? shownSeats(latest).map(seatText).join(' · ') : ''
    const words = stateText(config, cycle)
    // While Claude works, its question is moot: no asking actions.
    const isAsking = s.state === 'asking' && !e.props.isWorking

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text bold color={toneOf(s.state)}>Council</Text>
        <Text dimColor>{`${words}${seats ? ` · ${seats}` : ''}${words.includes('target') ? '' : ` · target ${formatScore(config.target)}`}`}</Text>
        {isAsking && <Button key="keep-fixing" label={goOnLabel(config, cycle)} variant="primary" onPress={() => keepFixing($)} />}
        {canAcceptIn(config, cycle) && <Button key="accept" label={acceptLabel(cycle)} variant={isAsking ? 'secondary' : 'primary'} onPress={() => accept($)} />}
        <Button key="open" label="Council…" onPress={() => $.ui.open({ id: PANE, title: TITLE })} />
      </Box>
    )
  })

  // The pane: the scorecard (a chart where the surface draws Svg, text bars on the terminal), what to do
  // next, every round, and the settings. Minimized to a widget on the desktop app, a glance.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Markdown, Text } = ui
    // Every build hands every element to every surface, so the surface decides: the terminal draws no Svg.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : undefined
    const config = await getConfig($)
    const cycle = await read($, cycleAtom)
    const isOnForNew = await read($, newSessionsAtom)
    const isWorking = await read($, workingAtom)
    const s = status(config, cycle), rows = lensRows(cycle), tone = toneOf(s.state)
    const hasScore = cycle.rounds.some(r => r.seats.some(x => x.score !== null))

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          <Text bold color={tone}>{config.isOn ? `Council · ${stateText(config, cycle)}` : 'Council · off'}</Text>
          {config.isOn && s.lowest !== null && <Text dimColor>{`Lowest ${formatScore(s.lowest)} · target ${formatScore(config.target)}`}</Text>}
        </Box>
      )
    }

    // Lower target: only where the scores of a complete, current round are the one thing below it.
    const latest = cycle.rounds.at(-1)
    const scoresBlock = Boolean(latest && isComplete(cycle, config, latest) && !isStale(cycle, latest)) && ['asking', 'fixing', 'limit'].includes(s.state)
    const lowerTo = scoresBlock && s.lowest !== null && s.lowest < config.target ? [...TARGETS].reverse().find(t => t < config.target && t <= s.lowest!) : undefined
    // Raise limit: past the rounds already used as well as the current limit, while one is left.
    const used = Math.max(config.maxRounds, cycle.rounds.length)
    const raiseTo = s.state === 'limit' && used < 100 ? ROUNDS.find(n => n > used) ?? Math.min(100, used + 10) : undefined
    const canAccept = canAcceptIn(config, cycle)
    const isAsking = s.state === 'asking' && !isWorking
    const table = firstAndFinal(cycle)
    // A lens name is text in the table, never Markdown.
    const cell = (text: string): string => text.replace(/[\\`*_[\]<>#|~&]/g, c => `\\${c}`)
    // A setting's options: the chosen one marked ✓. Primary is kept for the one action that matters now.
    const choices = (label: string, field: 'target' | 'maxRounds' | 'reviewers', options: readonly number[], name: (n: number) => string) => {
      const value = config[field]
      const all = options.includes(value) ? options : [...options, value].sort((a, b) => a - b)

      return (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Text>{label}</Text>
          {all.map(option => (
            <Button key={`${field}-${option}`} label={option === value ? `✓ ${name(option)}` : name(option)} onPress={() => setConfig($, { [field]: option })} />
          ))}
        </Box>
      )
    }
    const onOff = (label: string, key: string, isOn: boolean, set: (isOn: boolean) => unknown) => (
      <Box flexDirection="row" columnGap={1}>
        <Text>{label}</Text>
        <Button key={`${key}-on`} label={isOn ? '✓ On' : 'On'} onPress={() => set(true)} />
        <Button key={`${key}-off`} label={isOn ? 'Off' : '✓ Off'} onPress={() => set(false)} />
      </Box>
    )
    const settings = (
      <Box flexDirection="column" rowGap={1}>
        <Text bold>Settings</Text>
        {onOff('Council', 'council', config.isOn, isOn => setConfig($, { isOn }))}
        {choices('Target score', 'target', TARGETS, formatScore)}
        {choices('Max rounds', 'maxRounds', ROUNDS, String)}
        {choices('Reviewers', 'reviewers', REVIEWERS, n => (n ? String(n) : 'Auto'))}
        {onOff('New sessions start with Council', 'new', isOnForNew, async isOn => {
          await update($, newSessionsAtom, () => isOn)
          await writeDefaults($, { isOnForNewSessions: isOn })
        })}
      </Box>
    )

    if (!config.isOn) {
      return (
        <Box flexDirection="column" rowGap={1}>
          <Text dimColor>Reviewers score the work until all reach your target. Turn Council on and Claude convenes independent reviewers before it finishes work that changed files.</Text>
          {settings}
        </Box>
      )
    }

    // The terminal's scorecard: per lens, its name and verdict on a line and a bar below, all one width
    // (the pane's, at most 60 cells); too narrow for both on a line, the verdict gets its own.
    const width = Math.min(Math.max(e.props.bodyColumns, 12), 60)
    const terminalRows = rows.map(row => {
      const value = rowValue(row, config.target), nameWidth = width - cellWidth(value) - 1
      return (
        <Box flexDirection="column">
          {nameWidth >= 6
            ? (
              <Box flexDirection="row" columnGap={1}>
                <Text>{clipPad(row.lens, nameWidth)}</Text>
                <Text dimColor={row.latest.score === null}>{value}</Text>
              </Box>
            )
            : <Text>{clipPad(row.lens, width)}</Text>}
          {nameWidth < 6 && <Text dimColor={row.latest.score === null}>{value}</Text>}
          <Text color={rowTone(row, config.target)}>{textBar(row.latest.score, width, config.target)}</Text>
        </Box>
      )
    })
    // With no round yet, what happens next, by state.
    const noRound = s.state === 'accepted' ? 'Accepted before any round: no reviewers will be convened.'
      : s.state === 'asking' ? null
        : cycle.changedAt ? 'Files changed: Claude convenes reviewers before it finishes.'
          : 'No round yet. Claude convenes reviewers before it finishes work that changed files.'
    const roundLines = cycle.rounds.map(roundLine).filter((line): line is string => line !== null)

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="column">
          <Text bold color={tone}>{stateText(config, cycle)}</Text>
          <Text dimColor>{`Target ${formatScore(config.target)} · ${roundsUsed(cycle, config)} · ${config.reviewers ? `${config.reviewers} reviewers` : 'Claude picks the reviewers'}`}</Text>
        </Box>
        {isAsking && (
          <Box borderStyle="round" borderColor="warning" paddingX={1} flexDirection="column">
            <Text>{askingNotice(config, cycle)}</Text>
          </Box>
        )}
        {rows.length === 0
          ? noRound && <Text dimColor>{noRound}</Text>
          : Svg
            ? <Svg source={scorecardSvg(rows, config.target)} alt={scorecardAlt(rows, config.target)} isInteractive />
            : <Box flexDirection="column">{terminalRows}</Box>}
        {(canAccept || lowerTo !== undefined || raiseTo !== undefined || isAsking) && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {isAsking && <Button key="keep-fixing" label={goOnLabel(config, cycle)} variant="primary" onPress={() => keepFixing($)} />}
            {canAccept && <Button key="accept" label={acceptLabel(cycle)} variant={isAsking ? 'secondary' : 'primary'} onPress={() => accept($)} />}
            {lowerTo !== undefined && <Button key="lower" label={`Lower target to ${formatScore(lowerTo)}`} onPress={() => setConfig($, { target: lowerTo }, true)} />}
            {raiseTo !== undefined && <Button key="raise" label={`Raise limit to ${raiseTo} rounds`} onPress={() => setConfig($, { maxRounds: raiseTo }, true)} />}
          </Box>
        )}
        {roundLines.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Rounds</Text>
            {roundLines.map(line => <Text dimColor>{line}</Text>)}
          </Box>
        )}
        {hasScore && (cycle.rounds.length > 1 || s.state === 'passed' || s.state === 'accepted' || s.state === 'limit') && table.length > 0 && (
          <Markdown text={['| Lens | First | Final |', '| --- | ---: | ---: |', ...table.map(t => `| ${cell(t.lens)} | ${formatScore(t.first)} | ${formatScore(t.final)} |`)].join('\n')} />
        )}
        {settings}
      </Box>
    )
  })
}
