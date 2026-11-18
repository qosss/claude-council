/** What the person chose: whether Council is on in this session, the score every reviewer must reach,
 *  the rounds a cycle may start, and how many reviewers sit per round (0 = Claude picks, at least 2). */
export type CouncilConfig = {
  isOn: boolean
  target: number
  maxRounds: number
  reviewers: number
}

/** The settings a new session starts with, kept across sessions. */
export type CouncilDefaults = {
  target: number
  maxRounds: number
  reviewers: number
  isOnForNewSessions: boolean
}

/** One reviewer: the Agent call that seated it, its lens, and its score once it reported. */
export type CouncilSeat = {
  /** The Agent call's tool_use_id. */
  id: string
  /** The subagent's id once it started. */
  agentId: string | null
  lens: string
  score: number | null
  /** running: still reviewing; scored; failed: ended without a score; abandoned: a later round or a replacement took its place. */
  state: 'running' | 'scored' | 'failed' | 'abandoned'
  note: string | null
  createdAt: number
}

export type CouncilRound = {
  number: number
  /** When its first seat was dispatched: a change after this makes the round out of date. */
  startedAt: number
  seats: CouncilSeat[]
}

/** One cycle of review: a user request and the rounds that review what it changed. */
export type CouncilCycle = {
  since: number
  /** The newest write tool run this cycle (0: nothing changed). */
  changedAt: number
  rounds: CouncilRound[]
  /** The person accepted this cycle's scores. */
  isAccepted: boolean
  /** The refusal the finish gate last returned, so the same refusal brings Claude back only once. */
  lastBlock: string | null
  /** Claude stopped again on the same refusal: it is asking the person how to continue. */
  isAsking: boolean
}

declare module 'claude-code' {
  interface PluginState {
    council: {
      /** null until the session seeds it from the saved defaults. */
      config: Shaped<CouncilConfig | null>
      cycle: Shaped<CouncilCycle>
      /** Whether new sessions start with Council on (mirrors the saved defaults, so the pane redraws). */
      isOnForNewSessions: boolean
      /** Whether the main loop is mid-turn. */
      isWorking: boolean
      /** The Council rules the lead was last given ('' for none). */
      rulesKnown: string
    }
  }
}
