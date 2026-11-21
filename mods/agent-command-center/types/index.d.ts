export type Src = 'actual' | 'inferred'

export type Tokens = { i: number; o: number; cr: number; cc: number; n: number }

export type Todo = { content: string; status: string }

export type Agent = {
  id: string
  type: string
  task: string
  parentId?: string
  /** starting = spawn seen, no start confirmation yet */
  status: 'starting' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'stopped'
  startedAt: number
  lastActivityAt: number
  endedAt?: number
  activity: string
  activitySrc: Src
  activeMs: number
  turnOpenAt?: number
  tools: number
  toolFails: number
  todos?: Todo[]
  tokens: Tokens
  blocked?: string
  nextHandoff?: string
  model?: string
  ackAt?: number
  name?: string
  skill?: string
  spawnedAt?: number
}

export type Handoff = {
  id: string
  from: string
  to: string
  toType: string
  task: string
  spawnedAt: number
  ackAt?: number
  reportAt?: number
  status: 'dispatched' | 'acknowledged' | 'returned' | 'failed' | 'stopped' | 'refused'
  output?: string
  sourceDone: string
  remaining: string
}

export type TaskRec = { id: string; subject: string; who?: string; createdAt: number; doneAt?: number }

export type Evt = { t: number; k: string; src: Src; who?: string; text: string }

export type ToolRun = { id: string; tool: string; key: string; startAt: number; agentId?: string }

export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type RequestRec = {
  n: number
  text: string
  startAt: number
  endAt?: number
  base: Tokens
  tok?: Tokens
  agents: number
  tools: number
  toolFails: number
  retries: number
  outcome: 'running' | 'done' | 'interrupted' | 'error'
}

export type QuotaSample = { t: number; five?: number; week?: number }

export type Model = {
  title?: string
  sessionId: string
  sessionStart: number
  endedAt?: number
  request?: { n: number; text: string; startAt: number; endAt?: number; lastAgentReportAt?: number }
  requests: number
  agents: Record<string, Agent>
  order: string[]
  handoffs: Handoff[]
  tasks: Record<string, TaskRec>
  running: Record<string, ToolRun>
  failedTools: { tool: string; key: string; agentId?: string; startAt: number; endAt: number }[]
  curTask?: { label: string; since: number; src: Src }
  tokens: {
    total: Tokens
    byModel: Record<string, Tokens>
    byAgent: Record<string, Tokens>
    seen: string[]
    recent: { turnId: string; agent: string; model: string; t: number; i: number; o: number; cr: number; cc: number }[]
  }
  retries: { count: number; ms: number }
  turnErrors: number
  interruptions: number
  compactions: { count: number; lastAt?: number; lastTrigger?: string; open?: boolean }
  models: { current?: string; changes: { t: number; from: string; to: string }[] }
  quota?: { at: number; rateLimits: RateLimit[]; ctxTokens?: number; ctxWindow?: number; ctxPercent?: number; costUsd?: number }
  events: Evt[]
  requestsLog: RequestRec[]
  cov: Record<string, number>
  quotaHist: QuotaSample[]
  toasts: string[]
  alerted: string[]
  waitingNote?: string
}

export type History = {
  agentMs: Record<string, number[]>
  finalizeMs: number[]
  requestMs: number[]
}

/** One model per chat, keyed by the chat's session id. */
export type Book = Record<string, Model>

declare module 'claude-code' {
  interface PluginState {
    'agent-command-center': { model: Shaped<Book>; ui: Shaped<string[]> }
  }
}
