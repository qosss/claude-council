import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { clipWidth, lensRows, scorecardAlt, scorecardSvg } from '../hooks/chart'
import { emptyCycle } from '../hooks/logic'
import type { CouncilSeat } from '../types'

const seat = (lens: string, score: number | null, state: CouncilSeat['state'] = score === null ? 'running' : 'scored'): CouncilSeat =>
  ({ id: `${lens}-${score}`, agentId: null, lens, score, state, note: null, createdAt: 1 })

describe('scorecard chart', () => {
  test('one row per lens, history as dots with a key, the target as a rule', async () => {
    const cycle = {
      ...emptyCycle(0),
      rounds: [
        { number: 1, startedAt: 1, seats: [seat('security', 7), seat('ux', 9)] },
        { number: 2, startedAt: 5, seats: [seat('Security', 9.5), seat('ux', null)] },
      ],
    }
    const rows = lensRows(cycle)
    expect(rows).toEqual([
      { lens: 'security', history: [7], latest: { state: 'scored', score: 9.5 } },
      { lens: 'ux', history: [9], latest: { state: 'running', score: null } },
    ])
    const svg = scorecardSvg(rows, 9)
    expect(svg).toContain('target 9.0')
    expect(svg).toContain('9.5 · ✓ at target')
    expect(svg).toContain('reviewing…')
    expect(svg).toContain('earlier rounds')
    expect(svg).toContain('color-scheme:light dark')
    // Two earlier-round rings and the key's.
    expect(svg.match(/<circle/g)?.length).toBe(3)
    expect(scorecardAlt(rows, 9)).toBe('Council scores: 1 of 2 at target 9.0, lowest so far 9.5, 1 not yet scored. security: 9.5, at target (earlier 7.0); ux: reviewing (earlier 9.0).')
  })

  test('a lens name is text, never markup, and never breaks the document', async () => {
    const cycle = { ...emptyCycle(0), rounds: [{ number: 1, startedAt: 1, seats: [seat('<script>"x"&', 4), seat('a\u0001b\uD83D', 9)] }] }
    const svg = scorecardSvg(lensRows(cycle), 9)
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;&quot;x&quot;&amp;')
    expect(svg).toContain('✗ below')
    expect(svg).toContain('>ab<')
    expect(/[\u0000-\u0008]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(svg)).toBe(false)
  })

  test('a long name is clipped by its drawn width, by whole characters', async () => {
    const wide = clipWidth('可访问性和用户体验审查可访问性和用户体验审查', 120)
    expect(wide.endsWith('…')).toBe(true)
    expect(Array.from(wide).length).toBeLessThanOrEqual(9)
    const emoji = clipWidth('😀'.repeat(30), 120)
    expect(Array.from(emoji.slice(0, -1)).every(c => c === '😀')).toBe(true)
    const family = clipWidth('👨‍👩‍👧‍👦'.repeat(12), 60)
    expect(family.slice(0, -1).split('👨‍👩‍👧‍👦').every(part => part === '')).toBe(true)
    expect(clipWidth('Chart design and accessibility', 240)).toBe('Chart design and accessibility')
  })
})

function engine(on: On) {
  let agents = 0
  const submitted: string[] = []
  const store = new Map<string, unknown>()
  // The plugin's store, in memory, readable by the test.
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  const clock = mock.clock(on, { now: 1_000 })
  on('command.register', () => ({ value: { command: 'council' } }))
  on('agent.register', () => ({ value: { agent: 'council:reviewer' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {}, text: '' }))
  on('agent.spawn', () => ({ model: 'test-model', agentId: `agent-${++agents}` }))
  on('agent.list', () => ({ value: [] }))
  on('classic.Stop', () => ({}))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })

  return { clock, submitted, store }
}

const council = (args: string) => ({ command: 'council', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })
const spawn = (lens: string, id: string) => ({
  tool_use_id: id, prompt: 'Review it.', description: lens, subagentType: 'council:reviewer',
  provider: { plugin: 'council', tier: 'user' as const }, parentModel: 'test-model', background: false, fork: false,
})
const PANE = {
  plugin: 'council',
  component: 'Pane',
  requestId: 'council',
  props: { title: 'Council', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const BAND = {
  plugin: 'council',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const done = (agentId: string, score: number, turnId: string) =>
  ({ agentId, answer: `Council score: ${score}/10`, durationMs: 1, isAborted: false, turnId, reason: 'answer' as const })

type Kit = Engine

/** Council on, one write, and a round of two scored reviewers. */
async function round(kit: Kit, clock: ReturnType<typeof engine>['clock'], scores: [number, number], args = 'on') {
  await kit.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await kit.command.run(council(args))
  await clock.advance(10)
  await kit.tool.call({ tool: 'Write', file_path: '/x.ts', content: 'x' })
  await clock.advance(10)
  const a = await kit.agent.spawn(spawn('security', 't1'))
  const b = await kit.agent.spawn(spawn('ux', 't2'))
  await kit.turn.complete(done(a.agentId!, scores[0], 'r1'))
  await kit.turn.complete(done(b.agentId!, scores[1], 'r2'))
}

/** Brought back once, then stopping on the same refusal: Claude is asking. */
async function ask(kit: Kit) {
  await kit.classic.Stop({ stop_hook_active: false })
  await kit.classic.Stop({ stop_hook_active: true })
}

test('the pane draws a chart where the surface has Svg, and bars on the terminal', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(council('on'))
  await clock.advance(10)
  await $.tool.call({ tool: 'Write', file_path: '/x.ts', content: 'x' })
  await clock.advance(10)
  const a = await $.agent.spawn(spawn('security', 't1'))
  await $.agent.spawn(spawn('ux', 't2'))
  await $.turn.complete(done(a.agentId!, 8, 'r1'))

  for (const surface of ['desktop', 'mobile', 'vscode'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface })
    expect((await pane.find({ type: 'Svg' }))?.props.alt).toBe('Council scores: 0 of 2 at target 9.0, lowest so far 8.0, 1 not yet scored. security: 8.0, below target; ux: reviewing.')
    await pane.unmount()
  }
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /✗ below/ }))?.text).toBe('8.0 ✗ below 9.0')
  // A bar the pane's width (60 cells, the most it takes), the target marked ┃.
  expect((await pane.find({ type: 'Text', text: /█/ }))?.text).toBe(`${'█'.repeat(48)}${'░'.repeat(5)}┃${'░'.repeat(6)}`)
  // The name is padded so its verdict ends the line.
  expect((await pane.find({ type: 'Text', text: /^security/ }))?.text).toBe(`security${' '.repeat(60 - 8 - 15 - 1)}`)
  await pane.unmount()

  const widget = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, placement: 'widget' } })
  expect((await widget.find({ type: 'Text' }))?.text).toBe('Council · Round 1 of 10 · reviewing')
  expect((await widget.find({ type: 'Text', text: /Lowest/ }))?.text).toBe('Lowest 8.0 · target 9.0')
  await widget.unmount()
})

test('while Claude asks, Lower target passes the round for this session only', async ($, on) => {
  const { clock, store } = engine(on)
  await round($, clock, [8.5, 9.5])
  await ask($)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /asking how to continue/ }))?.text).toMatch(/8\.5, is below your target of 9\.0/)
  expect(await pane.find({ type: 'Button', key: 'keep-fixing' })).toBeTruthy()
  expect(await pane.find({ type: 'Button', key: 'accept' })).toBeTruthy()
  expect((await pane.find({ type: 'Button', key: 'lower' }))?.text).toBe('Lower target to 8.5')

  await pane.press({ key: 'lower' })
  expect((await $.command.run(council('status'))).text).toMatch(/Passed at 8\.5/)
  expect((store.get('defaults') as { target?: number } | undefined)?.target).not.toBe(8.5)
  await pane.unmount()
})

test('the band always holds a button that opens the pane, Council on or off', async ($, on) => {
  // engine() answers ui.open; this test answers it in its place, to count each open.
  const opened: string[] = []
  const register = on as (...args: unknown[]) => unknown
  engine(((event: string, ...rest: unknown[]) => (event === 'ui.open' ? undefined : register(event, ...rest))) as unknown as On)
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect((await band.find({ type: 'Text', text: /^(Off|On · target)/ }))?.text).toBe('Off')
    await band.press({ key: 'open' })
    await band.unmount()
  }
  expect(opened).toEqual(['council', 'council'])

  await $.command.run(council('on'))
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /^(Off|On · target)/ }))?.text).toBe('On · target 9.0')
  await band.press({ key: 'open' })
  expect(opened).toEqual(['council', 'council', 'council'])
  await band.unmount()
})

test('Keep fixing pressed on the band and the pane wakes Claude once', async ($, on) => {
  const { clock, submitted } = engine(on)
  await round($, clock, [6, 9.5])
  await ask($)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Both pressed before either redraws.
  await Promise.all([band.press({ key: 'keep-fixing' }), pane.press({ key: 'keep-fixing' })])
  await clock.advance(300)
  expect(submitted.filter(text => text.startsWith('Keep going.'))).toHaveLength(1)
  expect(submitted.at(-1)).toMatch(/lowest score, 6\.0\/10, is below the target/)
  // The wake was the one bring-back: stopping on the same refusal again asks the person.
  await $.classic.Stop({ stop_hook_active: false })
  expect((await $.command.run(council('status'))).text).toMatch(/Needs you: lowest 6\.0/)
  await band.unmount()
  await pane.unmount()
})

test('a change that changes nothing neither ends the asking nor wakes Claude', async ($, on) => {
  const { clock, submitted } = engine(on)
  await round($, clock, [6, 9.5])
  await ask($)
  await $.command.run(council('on'))
  await clock.advance(300)
  expect(submitted).toEqual([])
  expect((await $.command.run(council('status'))).text).toMatch(/Needs you/)
})

test('two settings changed at once both land', async ($, on) => {
  const { clock } = engine(on)
  await round($, clock, [9.5, 9.5])
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await Promise.all([pane.press({ key: 'target-9.5' }), pane.press({ key: 'maxRounds-25' })])
  expect((await $.command.run(council('status'))).text).toMatch(/target 9\.5 · 25 rounds/)
  await pane.unmount()
})

test('Raise limit reopens a cycle stopped at the limit and wakes Claude once', async ($, on) => {
  const { clock, submitted, store } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(council('rounds 1'))
  await round($, clock, [6, 9.5])
  expect((await $.command.run(council('status'))).text).toMatch(/Stopped at round limit \(1 of 1\)/)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Button', key: 'raise' }))?.text).toBe('Raise limit to 3 rounds')
  await pane.press({ key: 'raise' })
  await clock.advance(300)
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatch(/^The user raised the Council round limit\. Council round 1 of 3/)
  // A one-off: the saved limit stays the person's own.
  expect(store.get('defaults')).toMatchObject({ maxRounds: 1 })
  await pane.unmount()
})

test('an incomplete round asks about the missing reviewer, and offers no Lower target', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(council('on'))
  await clock.advance(10)
  await $.tool.call({ tool: 'Write', file_path: '/x.ts', content: 'x' })
  await clock.advance(10)
  const a = await $.agent.spawn(spawn('security', 't1'))
  const b = await $.agent.spawn(spawn('ux', 't2'))
  await $.turn.complete(done(a.agentId!, 8.5, 'r1'))
  await $.turn.complete({ agentId: b.agentId!, answer: 'No score line.', durationMs: 1, isAborted: false, turnId: 'r2', reason: 'answer' })
  await ask($)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /stopped with round/ }))?.text).toBe('Claude stopped with round 1 incomplete and is asking how to continue.')
  expect(await pane.find({ type: 'Button', key: 'lower' })).toBeFalsy()
  await pane.unmount()
})

test('a late report still scores a reviewer marked failed', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(council('on'))
  await clock.advance(10)
  await $.tool.call({ tool: 'Write', file_path: '/x.ts', content: 'x' })
  await clock.advance(10)
  const a = await $.agent.spawn(spawn('security', 't1'))
  await $.turn.complete({ agentId: a.agentId!, answer: 'No score yet.', durationMs: 1, isAborted: false, turnId: 'r1', reason: 'answer' })
  await $.turn.complete(done(a.agentId!, 9, 'r2'))
  expect((await $.command.run(council('status'))).text).toMatch(/security 9\.0/)
})
