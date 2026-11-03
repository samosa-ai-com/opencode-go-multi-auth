export type KeyStatus = 'active' | 'cooldown' | 'exhausted' | 'error'

export interface QuotaErrorSignal {
  statusCode: number
  occurredAt: number
  cooldownMs: number
  resetAt: number | null
  message: string
}

export type UsageWindow = {
  usedPercent: number
  status: string
  resetsAt: string | null
}

export type KeyUsage = {
  rolling: UsageWindow | null
  weekly: UsageWindow | null
  monthly: UsageWindow | null
  fetchedAt: string
  error: string | null
}

export interface ApiKey {
  id: string
  key: string
  alias: string
  addedAt: number
  enabled: boolean
  priority: number
  weight: number
  status: KeyStatus
  cooldownUntil: number | null
  consecutiveErrors: number
  tokensUsed: number
  costAccumulated: number
  quotaErrorCount: number
  lastQuotaError: QuotaErrorSignal | null
  requestCount: number
  successCount: number
  errorCount: number
  averageLatencyMs: number
  lastUsedAt: number | null
  lastStatusCode: number | null
  lastModel: string | null
  lastSessionId: string | null
}

export interface StoredApiKey {
  id: string
  key: string
  alias: string
  addedAt: number
  enabled: boolean
  priority: number
  weight: number
}

export enum RoutingStrategy {
  PRIORITY_FAILOVER = 'priority_failover',
  ROUND_ROBIN = 'round_robin',
  WEIGHTED_ROUND_ROBIN = 'weighted_round_robin',
}

export interface RoutingStrategyInfo {
  value: RoutingStrategy
  label: string
  description: string
  bestFor: string
  behavior: string
  cacheFriendly: boolean
  usesPriority: boolean
  usesWeight: boolean
  recommended?: boolean
}

export interface KeySelectionContext {
  excludeKeyIds?: Set<string>
}

export interface KeySelection {
  key: ApiKey
  reason: string
}

export interface RouterConfig {
  upstreamUrl: string
  upstreamUrlZen: string
  dashboardPort: number
  proxyPort: number
  cooldownMs: number
  circuitBreakerThreshold: number
  logLevel: string
  configDir: string
  strategy: RoutingStrategy
  ntfyUrl: string
  visibleModels: string
  requestTimeoutMs: number
  upstreamHungTimeoutMs: number
  keepAliveTimeoutMs: number
  headersTimeoutMs: number
  usagePollMs: number
}

export const ROUTING_STRATEGIES: RoutingStrategyInfo[] = [
  {
    value: RoutingStrategy.PRIORITY_FAILOVER,
    label: 'Priority Failover',
    description: 'Keep one account warm for cache reuse and only move to the next account when the current one is unavailable.',
    bestFor: 'Best default for cache-heavy coding sessions.',
    behavior: 'Always uses the lowest priority number first. Session stickiness can still pin a warm conversation to its current account. Failover is triggered by upstream 4xx/5xx, not by an estimated quota.',
    cacheFriendly: true,
    usesPriority: true,
    usesWeight: false,
    recommended: true,
  },
  {
    value: RoutingStrategy.ROUND_ROBIN,
    label: 'Round Robin',
    description: 'Cycle requests evenly across active accounts.',
    bestFor: 'Simple spreading when cache reuse is less important than fairness.',
    behavior: 'Each new uncached request advances to the next active account. Sticky sessions still keep warm conversations on one account.',
    cacheFriendly: false,
    usesPriority: false,
    usesWeight: false,
  },
  {
    value: RoutingStrategy.WEIGHTED_ROUND_ROBIN,
    label: 'Weighted Cycle',
    description: 'Cycle requests across accounts in proportion to each key weight.',
    bestFor: 'Use when some accounts should receive more traffic than others.',
    behavior: 'A key with weight 4 receives roughly four times as many fresh requests as a key with weight 1.',
    cacheFriendly: false,
    usesPriority: false,
    usesWeight: true,
  },
]

export function normalizeRoutingStrategy(value?: string): RoutingStrategy {
  if (value === 'exhaustion_failover') return RoutingStrategy.PRIORITY_FAILOVER
  // Legacy strategies map to the closest current strategy. Removed strategies
  // (priority_spillover, highest_remaining_quota) become priority_failover
  // since the router no longer estimates quota to drive pre-emptive routing.
  if (value === 'priority_spillover' || value === 'highest_remaining_quota') {
    return RoutingStrategy.PRIORITY_FAILOVER
  }
  if (value && Object.values(RoutingStrategy).includes(value as RoutingStrategy)) {
    return value as RoutingStrategy
  }
  return RoutingStrategy.PRIORITY_FAILOVER
}

export function getRoutingStrategyInfo(strategy: RoutingStrategy): RoutingStrategyInfo {
  return ROUTING_STRATEGIES.find(entry => entry.value === strategy) ?? ROUTING_STRATEGIES[0]
}

export const DEFAULT_CONFIG: RouterConfig = {
  upstreamUrl: 'https://opencode.ai/zen/go/v1',
  upstreamUrlZen: 'https://opencode.ai/zen/v1',
  dashboardPort: 18904,
  proxyPort: 18905,
  cooldownMs: 5 * 60 * 60 * 1000,
  circuitBreakerThreshold: 3,
  logLevel: 'info',
  configDir: '',
  strategy: RoutingStrategy.PRIORITY_FAILOVER,
  ntfyUrl: '',
  visibleModels: '',
  requestTimeoutMs: 0,
  upstreamHungTimeoutMs: 0,
  keepAliveTimeoutMs: 5 * 60 * 1000,
  headersTimeoutMs: 60 * 1000,
  usagePollMs: 60 * 1000,
}

export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open',
}
