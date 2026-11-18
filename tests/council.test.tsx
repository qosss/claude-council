import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseScore } from '../hooks/logic'

describe('parseScore', () => {
  test('reads the last Council score line, past markdown', async () => {
    expect(parseScore('Findings...\n\n**Council score: 8.5/10**')).toBe(8.5)
    expect(parseScore('Council score: 7/10\nmore\n## council score = 9 / 10')).toBe(9)
    expect(parseScore('> Council Score: 10')).toBe(10)
  })
  test('refuses what is not a score', async () => {
    expect(parseScore('no score here')).toBe(null)
    expect(parseScore('Council score: 11/10')).toBe(null)
    expect(parseScore('Council score: 8/100')).toBe(null)
    expect(parseScore('Council score: 8x')).toBe(null)
    expect(parseScore('Council score: N/10')).toBe(null)
  })
})

/** The engine beneath the mod: each hook here answers as the engine would. */
function engine(on: On) {
  const submitted: string[] = []
  const contexts: (readonly string[] | undefined)[] = []
  let agents = 0
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000 })
  on('command.register', () => ({ value: { command: 'council' } }))
  on('agent.register', () => ({ value: { agent: 'council:reviewer' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {}, text: '' }))
  on('agent.spawn', () => ({ model: 'test-model', agentId: `agent-${++agents}` }))
  on('agent.list', () => ({ value: [] }))
  on('classic.Stop', () => ({}))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    contexts.push(e.context)
    return { text: e.text }
  })

  return { submitted, contexts, clock }
}

const spawn = (lens: string, id: string) => ({
  tool_use_id: id,
  prompt: 'Review the change to src/x.ts against the user\'s goal.',
  description: lens,
  subagentType: 'council:reviewer',
  provider: { plugin: 'council', tier: 'user' as const },
  parentModel: 'test-model',
  background: false,
  fork: false,
})

/** /council as typed at the prompt. */
const council = (args: string) => ({
  command: 'council',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

const report = (score: number) => `Looked at everything.\n\nCouncil score: ${score}/10`

test('the gate holds Claude to the lowest score, then lets it finish', async ($, on) => {
  const { submitted, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(council('on'))
  await $.command.run(council('target 9'))

  // Nothing changed yet: no council needed.
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()

  // A write makes a council due.
  await clock.advance(10)
  await $.tool.call({ tool: 'Write', file_path: '/src/x.ts', content: 'x' })
  await clock.advance(10)
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toMatch(/convene a council/)

  // Round 1: two lenses.
  const a = await $.agent.spawn(spawn('security', 't1'))
  const b = await $.agent.spawn(spawn('correctness', 't2'))
  expect(a.deny).toBeUndefined()
  expect(b.deny).toBeUndefined()
  await $.turn.complete({ agentId: a.agentId!, answer: report(9.5), durationMs: 1, isAborted: false, turnId: 'r1', reason: 'answer' })
  await $.turn.complete({ agentId: b.agentId!, answer: report(7), durationMs: 1, isAborted: false, turnId: 'r2', reason: 'answer' })

  // Below target: Claude is brought back with the scores.
  const below = await $.classic.Stop({ stop_hook_active: false })
  expect(below.block).toMatch(/lowest score, 7\.0\/10, is below the target 9\.0/)

  // Round 2 may not add a lens, and may not re-roll before a fix.
  expect((await $.agent.spawn(spawn('performance', 't3'))).deny).toMatch(/scored below the target and nothing changed/)
  await clock.advance(10)
  await $.tool.call({ tool: 'Edit', file_path: '/src/x.ts', old_string: 'x', new_string: 'y' })
  await clock.advance(10)
  expect((await $.agent.spawn(spawn('performance', 't3'))).deny).toMatch(/Round 1 fixed the Council lenses/)

  const c = await $.agent.spawn(spawn('Security', 't4'))
  const d = await $.agent.spawn(spawn('correctness', 't5'))
  await $.turn.complete({ agentId: c.agentId!, answer: report(9), durationMs: 1, isAborted: false, turnId: 'r3', reason: 'answer' })
  await $.turn.complete({ agentId: d.agentId!, answer: report(9.5), durationMs: 1, isAborted: false, turnId: 'r4', reason: 'answer' })

  // Every reviewer at the target: the gate lets Claude finish.
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  expect((await $.command.run(council('status'))).text).toMatch(/Passed at 9\.0/)
  expect(submitted).toEqual([])
})

test('stopping twice on the same refusal asks the person, and Accept lets Claude finish', async ($, on) => {
  const { submitted, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(council('on'))
  await clock.advance(10)
  await $.tool.call({ tool: 'Write', file_path: '/src/x.ts', content: 'x' })
  await clock.advance(10)
  const a = await $.agent.spawn(spawn('ux', 't1'))
  const b = await $.agent.spawn(spawn('security', 't2'))
  await $.turn.complete({ agentId: a.agentId!, answer: report(6), durationMs: 1, isAborted: false, turnId: 'r1', reason: 'answer' })
  await $.turn.complete({ agentId: b.agentId!, answer: 'I forgot the score line.', durationMs: 1, isAborted: false, turnId: 'r2', reason: 'answer' })

  // A reviewer that ended without a score must be re-seated.
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toMatch(/ended without a score \(security\)/)
  const again = await $.agent.spawn(spawn('security', 't3'))
  await $.turn.complete({ agentId: again.agentId!, answer: report(9.5), durationMs: 1, isAborted: false, turnId: 'r3', reason: 'answer' })

  expect((await $.classic.Stop({ stop_hook_active: false })).block).toMatch(/below the target/)
  // Claude stops again on the same refusal: it is asking.
  expect((await $.classic.Stop({ stop_hook_active: true })).block).toBeUndefined()
  expect((await $.command.run(council('status'))).text).toMatch(/Needs you/)

  expect((await $.command.run(council('accept'))).text).toMatch(/accepted/)
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  await clock.advance(300)
  expect(submitted.at(-1)).toMatch(/accepted the current Council scores/)
})

test('reviewers are refused while Council is off, and never followed up', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.agent.spawn(spawn('security', 't1'))).deny).toMatch(/Council is off/)
  await $.command.run(council('on'))
  const a = await $.agent.spawn(spawn('security', 't2'))
  const followUp = await $.tool.call({ tool: 'SendMessage', to: a.agentId!, message: 'Look again' })
  expect(followUp.deny).toMatch(/never followed up/)
})

const BAND = {
  plugin: 'council',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const PANE = {
  plugin: 'council',
  component: 'Pane',
  requestId: 'council',
  props: { title: 'Council', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('the band and pane show the round and take settings, on every surface', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(council('on'))
  await clock.advance(10)
  await $.tool.call({ tool: 'Write', file_path: '/src/x.ts', content: 'x' })
  await clock.advance(10)
  const a = await $.agent.spawn(spawn('security', 't1'))
  await $.agent.spawn(spawn('ux', 't2'))
  await $.turn.complete({ agentId: a.agentId!, answer: report(8), durationMs: 1, isAborted: false, turnId: 'r1', reason: 'answer' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect((await band.find({ type: 'Text', text: /reviewing/ }))?.text).toMatch(/security 8\.0 · ux …/)
    await band.unmount()

    const pane = await $.ui.mount({ ...PANE, surface })
    expect((await pane.find({ type: 'Text', text: /lowest 8\.0/ }))?.text).toBe('Round 1 · lowest 8.0: security 8.0 · ux …')
    await pane.unmount()
  }

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'target-9.5' })
  expect((await $.command.run(council('status'))).text).toMatch(/target 9\.5/)
  await pane.unmount()
})

test('where the system prompt is passed by, the rules ride along with the prompt once', async ($, on) => {
  const { contexts } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(council('on'))
  await $.prompt.submit({ text: 'Fix the parser.', wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({ text: 'Also the tests.', wait: false, origin: { kind: 'composer' } })
  expect(contexts[0]?.join('\n')).toMatch(/# Council\nCouncil is on, target 9\.0\/10/)
  expect(contexts[1]).toBeUndefined()
})

test('where the Stop gate is passed by, the refusal arrives at the turn\'s end', async ($, on) => {
  const { submitted, clock } = engine(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(council('on'))
  await $.turn.start({ text: 'Fix the parser.', turnId: 'main-1' })
  await clock.advance(10)
  await $.tool.call({ tool: 'Write', file_path: '/src/x.ts', content: 'x' })
  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 'main-1', reason: 'answer' })
  await clock.advance(300)
  expect(submitted.at(-1)).toMatch(/^Council: Council is on \(target 9\.0\/10\) and files changed/)
})
