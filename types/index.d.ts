/** One usage window: a rolling limit of the plan, as a percentage used. */
export type UsageWindow = {
  /** The account API's key: `five_hour`, `seven_day`, `seven_day_opus`, ... */
  id: string
  /** 0 to 100 (past 100 when exceeded). */
  percent: number
  /** ISO 8601 timestamp of the reset, when known. */
  resetsAt?: string
}

/** Pay-as-you-go usage beyond the plan, when the account has it on. */
export type ExtraUsage = {
  isEnabled: boolean
  percent?: number
  usedCredits?: number
  monthlyLimit?: number
}

/** One product's part of the weekly window. */
export type BreakdownRow = {
  key: string
  label: string
  /** Its share of what was used this week, 0 to 100. */
  share: number
  /** Its part of the weekly limit, 0 to 100. */
  ofLimit: number
}

/** Everything the panel and the band draw, as of one refresh. */
export type UsageSnapshot = {
  /** Epoch milliseconds of this refresh. */
  fetchedAt: number
  /** `account`: the live account endpoint; `session`: the last API response of this session. */
  source: 'account' | 'session' | 'none'
  windows: UsageWindow[]
  extra?: ExtraUsage
  /** The weekly window split by product, as the account reports it. */
  breakdown?: BreakdownRow[]
  context?: { tokens?: number; window: number; percent?: number }
  costUsd?: number
  /** Why the account endpoint was not used, when it was not. */
  error?: string
}

/** Token counts, as the API reports them, summed. */
export type TokenCounts = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Responses counted. */
  turns: number
}

/** One local day of Claude Code use, summed over every session with the mod on. */
export type DayTotal = TokenCounts & {
  /** The local date, `YYYY-MM-DD`. */
  day: string
  /** Estimated at API prices; not a bill. */
  usd: number
}

/** One reading of the 5-hour window, for the history and the projection. */
export type UsageSample = { t: number; p: number; r?: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-monitor': {
      snapshot: Shaped<UsageSnapshot | null>
      history: Shaped<UsageSample[]>
      isRefreshing: boolean
      isBandHidden: boolean
      /** This conversation's tokens since the mod loaded in it. */
      chatTokens: Shaped<TokenCounts>
      /** The last days of use, newest last; mirrored from the shared store. */
      ledger: Shaped<DayTotal[]>
      /** The session cost already counted into the ledger. */
      costSeen: number
    }
  }
}
