import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

/** The engine beneath the mod, with the prompts it was handed and its store readable by the test. */
function engine(on: On, whileSpawning?: () => Promise<unknown>) {
  let agents = 0
  const submitted: { text: string; context: readonly string[] | undefined }[] = []
  const store = new Map<string, unknown>()
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
  // The tasks the mod stopped, by id.
  const stopped: string[] = []
  on('tool.call', (_, e) => {
    if (e.tool === 'TaskStop' && e.task_id) stopped.push(e.task_id)
    return { result: {}, text: '' }
  })
  // What the person does while an agent is still starting, if anything.
  on('agent.spawn', async () => {
    const agentId = `agent-${++agents}`
    await whileSpawning?.()
    return { model: 'test-model', agentId }
  })
  on('agent.list', () => ({ value: [] }))
  on('classic.Stop', () => ({}))
  on('classic.PostCompact', () => ({}))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => {
    submitted.push({ text: e.text, context: e.context })
    return { text: e.text }
  })
  const texts = () => submitted.map(s => s.text)

  return { clock, submitted, texts, store, stopped }
}

const council = (args: string) => ({ command: 'council', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 100 } })
const spawn = (lens: string, id: string) => ({
  tool_use_id: id, prompt: 'Review it.', description: lens, subagentType: 'council:reviewer',
  provider: { plugin: 'council', tier: 'user' as const }, parentModel: 'test-model', background: false, fork: false,
})
const done = (agentId: string, answer: string, turnId: string) =>
  ({ agentId, answer, durationMs: 1, isAborted: false, turnId, reason: 'answer' as const })
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
const BAND = {
  plugin: 'council', component: 'AbovePrompt', requestId: 'band',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const PANE = {
  plugin: 'council', component: 'Pane', requestId: 'council',
  props: { title: 'Council', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

type Clock = ReturnType<typeof engine>['clock']

async function changed($: Engine, clock: Clock, args = 'on') {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(council(args))
  await clock.advance(10)
  await $.tool.call({ tool: 'Write', file_path: '/x.ts', content: 'x' })
  await clock.advance(10)
}
async function round($: Engine, answers: [string, string]) {
  const a = await $.agent.spawn(spawn('security', 't1'))
  const b = await $.agent.spawn(spawn('ux', 't2'))
  await $.turn.complete(done(a.agentId!, answers[0], 'r1'))
  await $.turn.complete(done(b.agentId!, answers[1], 'r2'))
}
async function ask($: Engine) {
  await $.classic.Stop({ stop_hook_active: false })
  await $.classic.Stop({ stop_hook_active: true })
}
const status = async ($: Engine) => (await $.command.run(council('status'))).text

test('asking before any round shows it, with Keep fixing and Accept', async ($, on) => {
  const { clock } = engine(on)
  await changed($, clock)
  await ask($)
  expect(await status($)).toMatch(/Needs you: no council convened yet/)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Button', key: 'keep-fixing' })).toBeTruthy()
  expect(await band.find({ type: 'Button', key: 'accept' })).toBeTruthy()
  await band.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /without convening/ }))?.text).toBe('Files changed, and Claude stopped without convening a council.')
  await pane.unmount()
})

test('Accept is offered when no reviewer scored, and once accepted no reviewer is seated', async ($, on) => {
  const { clock, texts } = engine(on)
  await changed($, clock)
  await round($, ['No score.', 'No score either.'])
  await ask($)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await Promise.all([band.press({ key: 'accept' }), $.command.run(council('accept'))])
  await clock.advance(300)
  expect(texts().filter(t => t.startsWith('The user chose to finish without a Council review'))).toHaveLength(1)
  expect((await $.agent.spawn(spawn('security', 't9'))).deny).toMatch(/accepted the Council scores/)
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  await band.unmount()
})

test('Accept while Claude works reaches it once its turn ends', async ($, on) => {
  const { clock, texts } = engine(on)
  await changed($, clock)
  await $.turn.start({ text: 'Fix it.', turnId: 'main-1' })
  await round($, ['Council score: 6/10', 'Council score: 9.5/10'])
  expect((await $.command.run(council('accept'))).text).toMatch(/finishes once its current step ends/)
  await clock.advance(300)
  expect(texts().at(-1)).toMatch(/^The user accepted the current Council scores: convene no more reviewers/)
})

test('a one-off value never reaches the defaults through a later setting', async ($, on) => {
  const { clock, store } = engine(on)
  await changed($, clock)
  await round($, ['Council score: 8.5/10', 'Council score: 9.5/10'])
  await ask($)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'lower' })
  await pane.press({ key: 'reviewers-3' })
  expect(store.get('defaults')).toMatchObject({ reviewers: 3 })
  expect((store.get('defaults') as { target: number }).target).not.toBe(8.5)
  await pane.unmount()
})

test('a full round that is not complete is never skipped by re-seating a lens', async ($, on) => {
  const { clock } = engine(on)
  await changed($, clock, 'reviewers 2')
  await $.command.run(council('on'))
  await round($, ['Council score: 6/10', 'No score.'])
  expect((await $.agent.spawn(spawn('security', 't3'))).deny).toMatch(/"security" already sits in Council round 1/)
  expect((await $.agent.spawn(spawn('perf', 't4'))).deny).toMatch(/round 1 is full: seat again only a lens whose reviewer ended without a score \(ux\)/)
  expect((await $.agent.spawn(spawn('ux', 't5'))).deny).toBeUndefined()
  expect(await status($)).toMatch(/Round 1 of 10 · reviewing/)
})

test('a change while asking that lands on the limit says so, never that the work passes', async ($, on) => {
  const { clock, texts } = engine(on)
  await changed($, clock)
  await round($, ['Council score: 6/10', 'Council score: 9.5/10'])
  await ask($)
  await $.command.run(council('rounds 1'))
  await clock.advance(300)
  expect(texts()).toHaveLength(1)
  expect(texts()[0]).toMatch(/round limit is reached: make no more changes/)
  expect(texts()[0]).not.toMatch(/passes/)
})

test('two changes at once while asking wake Claude once', async ($, on) => {
  const { clock, texts } = engine(on)
  await changed($, clock)
  await round($, ['Council score: 8.5/10', 'Council score: 9.5/10'])
  await ask($)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await Promise.all([pane.press({ key: 'lower' }), pane.press({ key: 'keep-fixing' })])
  await clock.advance(300)
  expect(texts()).toHaveLength(1)
  await pane.unmount()
})

test('the rules ride along when they change, and a plugin\'s prompt is not the person\'s reply', async ($, on) => {
  const { clock, submitted } = engine(on)
  await changed($, clock)
  await $.prompt.submit(typed('Build it.'))
  await $.prompt.submit(typed('More.'))
  await $.command.run(council('target 9.5'))
  await $.prompt.submit(typed('And this.'))
  await $.command.run(council('off'))
  await $.prompt.submit(typed('Thanks.'))
  const contexts = submitted.map(s => s.context?.join('\n') ?? '')
  expect(contexts[0]).toMatch(/target 9\.0\/10/)
  expect(contexts[1]).toBe('')
  expect(contexts[2]).toMatch(/target 9\.5\/10/)
  expect(contexts[3]).toMatch(/Council is off now/)

  // Brought back once on a refusal; a plugin's prompt in between does not reset that.
  await $.command.run(council('on'))
  await clock.advance(10)
  await $.tool.call({ tool: 'Write', file_path: '/y.ts', content: 'y' })
  await $.classic.Stop({ stop_hook_active: false })
  await $.prompt.submit({ text: 'A plugin speaks.', wait: false, origin: { kind: 'plugin', name: 'other' } })
  await $.classic.Stop({ stop_hook_active: true })
  expect(await status($)).toMatch(/Needs you/)
})

test('a reviewer count changed mid-cycle never asks a later round for seats no lens may fill', async ($, on) => {
  const { clock } = engine(on)
  await changed($, clock)
  await round($, ['Council score: 6/10', 'Council score: 9.5/10'])
  await $.command.run(council('reviewers 3'))
  await clock.advance(10)
  await $.tool.call({ tool: 'Edit', file_path: '/x.ts', old_string: 'x', new_string: 'y' })
  await clock.advance(10)
  const a = await $.agent.spawn(spawn('security', 't3'))
  const b = await $.agent.spawn(spawn('ux', 't4'))
  await $.turn.complete(done(a.agentId!, 'Council score: 9.5/10', 'r3'))
  await $.turn.complete(done(b.agentId!, 'Council score: 9.5/10', 'r4'))
  expect(await status($)).toMatch(/Passed at 9\.5/)
})

test('the last round at the limit must still finish, then the limit is said once and Claude finishes', async ($, on) => {
  const { clock } = engine(on)
  await changed($, clock, 'rounds 1')
  await $.command.run(council('on'))
  const a = await $.agent.spawn(spawn('security', 't1'))
  await $.turn.complete(done(a.agentId!, 'Council score: 4/10', 'r1'))
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toMatch(/round 1 is incomplete/)
  const b = await $.agent.spawn(spawn('ux', 't2'))
  await $.turn.complete(done(b.agentId!, 'Council score: 9/10', 'r2'))
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toMatch(/round limit is reached: make no more changes/)
  expect((await $.classic.Stop({ stop_hook_active: true })).block).toBeUndefined()
  expect(await status($)).toMatch(/Stopped at round limit \(1 of 1\): lowest 4\.0 below target 9\.0/)
})

test('a reviewer that keeps failing turns into asking, and retries stop after three', async ($, on) => {
  const { clock } = engine(on)
  await changed($, clock)
  await round($, ['Council score: 9/10', 'No score.'])
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toMatch(/incomplete/)
  const again = await $.agent.spawn(spawn('ux', 't3'))
  await $.turn.complete(done(again.agentId!, 'Still no score.', 'r3'))
  // The same refusal: Claude is now asking, not brought back again.
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  expect(await status($)).toMatch(/Needs you: round 1 incomplete/)
  const third = await $.agent.spawn(spawn('ux', 't4'))
  await $.turn.complete(done(third.agentId!, 'Nope.', 'r4'))
  expect((await $.agent.spawn(spawn('ux', 't5'))).deny).toMatch(/ended without a score 3 times/)
})

test('a resumed conversation starts its council over, and the rules go again after a compaction', async ($, on) => {
  const { clock, submitted } = engine(on)
  await changed($, clock)
  await $.prompt.submit(typed('Build it.'))
  await $.classic.PostCompact({ trigger: 'auto', compact_summary: 'Summary.' })
  await $.prompt.submit(typed('Continue.'))
  expect(submitted.map(s => s.context?.length ?? 0)).toEqual([1, 1])
  await $.session.end({ reason: 'resume', sessionId: 's', resume: { kind: 'none' } } as never)
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
})

test('two settings at once both reach the saved defaults', async ($, on) => {
  const { clock, store } = engine(on)
  await changed($, clock)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await Promise.all([pane.press({ key: 'target-9.5' }), pane.press({ key: 'maxRounds-25' })])
  expect(store.get('defaults')).toMatchObject({ target: 9.5, maxRounds: 25 })
  await pane.unmount()
})

test('a new target after a pass holds the next work to it, not the work that passed', async ($, on) => {
  const { clock } = engine(on)
  await changed($, clock)
  await round($, ['Council score: 9/10', 'Council score: 9/10'])
  expect(await status($)).toMatch(/Passed at 9\.0/)
  await $.command.run(council('target 9.5'))
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  expect(await status($)).toMatch(/Waiting for changes to review/)
})

test('accepting while reviewers run stops them and shows them stopped', async ($, on) => {
  const { clock, stopped } = engine(on)
  await changed($, clock)
  await $.agent.spawn(spawn('security', 't1'))
  await $.agent.spawn(spawn('ux', 't2'))
  await $.command.run(council('accept'))
  await clock.advance(10)
  expect(stopped).toEqual(['agent-1', 'agent-2'])
  // Accepting again stops nothing more.
  await $.command.run(council('accept'))
  await clock.advance(10)
  expect(stopped).toHaveLength(2)
  expect(await status($)).toMatch(/Round 1: security stopped · ux stopped/)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /stopped$/ }))?.text).toBe('stopped')
  await pane.unmount()
})

test('turning Council off stops only the reviewers still running', async ($, on) => {
  const { clock, stopped } = engine(on)
  await changed($, clock)
  const a = await $.agent.spawn(spawn('security', 't1'))
  await $.agent.spawn(spawn('ux', 't2'))
  await $.turn.complete(done(a.agentId!, 'Council score: 8/10', 'r1'))
  await $.command.run(council('off'))
  await clock.advance(10)
  expect(stopped).toEqual(['agent-2'])
})

test('a reviewer accepted away while it was still starting is stopped once it has an id', async ($, on) => {
  let acceptNow = false
  const { clock, stopped } = engine(on, async () => {
    if (acceptNow) await $.command.run(council('accept'))
  })
  await changed($, clock)
  await $.agent.spawn(spawn('security', 't1'))
  acceptNow = true
  await $.agent.spawn(spawn('ux', 't2'))
  await clock.advance(10)
  expect(stopped.sort()).toEqual(['agent-1', 'agent-2'])
})

test('a new round opened over running reviewers stops them', async ($, on) => {
  const { clock, stopped } = engine(on)
  await changed($, clock)
  await $.agent.spawn(spawn('security', 't1'))
  await $.agent.spawn(spawn('ux', 't2'))
  await clock.advance(10)
  await $.tool.call({ tool: 'Write', file_path: '/y.ts', content: 'y' })
  await clock.advance(10)
  await $.agent.spawn(spawn('security', 't3'))
  await clock.advance(10)
  expect(stopped).toEqual(['agent-1', 'agent-2'])
})
