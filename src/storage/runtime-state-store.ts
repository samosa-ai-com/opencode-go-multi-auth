import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { KeyUsage } from '../router/types.js'

export interface StoredUsageLogEntry {
  timestamp: number
  cost: number | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}

export interface StoredQuotaEntry {
  keyId: string
  tokensInput: number
  tokensOutput: number
  tokensCacheRead: number
  tokensCacheWrite: number
  tokensReasoning: number
  costAccumulated: number
  costObservedCount: number
  usageLog: StoredUsageLogEntry[]
}

export interface StoredQuotaError {
  statusCode: number
  occurredAt: number
  cooldownMs: number
  resetAt: number | null
  message: string
}

export interface StoredKeyRuntimeState {
  id: string
  status: string
  cooldownUntil: number | null
  consecutiveErrors: number
  tokensUsed: number
  costAccumulated: number
  quotaErrorCount: number
  lastQuotaError: StoredQuotaError | null
  requestCount: number
  successCount: number
  errorCount: number
  averageLatencyMs: number
  lastUsedAt: number | null
  lastStatusCode: number | null
  lastModel: string | null
  lastSessionId: string | null
  // Absent in state files written before usage polling existed.
  usage?: KeyUsage | null
}

export interface StoredLogEntry {
  timestamp: string
  level: string
  message: string
  meta?: Record<string, unknown>
}

export interface RouterRuntimeState {
  version: number
  keys: StoredKeyRuntimeState[]
  quota: StoredQuotaEntry[]
  logs: StoredLogEntry[]
}

const CURRENT_VERSION = 1

export class RuntimeStateStore {
  private readonly filePath: string

  constructor(configDir: string) {
    const dir = configDir || path.join(os.homedir(), '.opencode')
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    this.filePath = path.join(dir, 'router-state.json')
  }

  load(): RouterRuntimeState {
    if (!fs.existsSync(this.filePath)) {
      return this.emptyState()
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<RouterRuntimeState>
      return {
        version: CURRENT_VERSION,
        keys: Array.isArray(parsed.keys) ? parsed.keys : [],
        quota: Array.isArray(parsed.quota) ? parsed.quota : [],
        logs: Array.isArray(parsed.logs) ? parsed.logs : [],
      }
    } catch {
      return this.emptyState()
    }
  }

  save(state: Omit<RouterRuntimeState, 'version'>): void {
    const payload: RouterRuntimeState = {
      version: CURRENT_VERSION,
      keys: state.keys,
      quota: state.quota,
      logs: state.logs,
    }
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8')
  }

  private emptyState(): RouterRuntimeState {
    return {
      version: CURRENT_VERSION,
      keys: [],
      quota: [],
      logs: [],
    }
  }
}
