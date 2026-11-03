import type { KeyUsage, UsageWindow } from '../router/types.js'

export type UsageSnapshot = Pick<KeyUsage, 'rolling' | 'weekly' | 'monthly' | 'supported'>

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_ERROR_LENGTH = 200

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function parsePercent(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN
  if (!Number.isFinite(parsed)) return null
  return Math.min(100, Math.max(0, parsed))
}

function parseResetsAt(raw: Record<string, unknown>, now: number): string | null {
  if (typeof raw.resetsAt === 'string' && raw.resetsAt.trim()) {
    const parsed = Date.parse(raw.resetsAt)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
  }
  // Legacy payloads report a relative number of seconds instead of an ISO timestamp.
  const resetInSec = typeof raw.resetInSec === 'number' ? raw.resetInSec : Number.NaN
  if (Number.isFinite(resetInSec) && resetInSec >= 0) {
    return new Date(now + resetInSec * 1000).toISOString()
  }
  return null
}

function parseWindow(value: unknown, now: number): UsageWindow | null {
  const raw = asRecord(value)
  if (!raw) return null

  const usedPercent = parsePercent(raw.percent ?? raw.usedPercent)
  const status = typeof raw.status === 'string' ? raw.status : ''
  // Keep a status-only window so the dashboard can still show "rate-limited".
  if (usedPercent === null && !status) return null

  return {
    usedPercent: usedPercent ?? 0,
    status: status || 'unknown',
    resetsAt: parseResetsAt(raw, now),
  }
}

function redactKeys(value: string): string {
  return value.replace(/\b(?:oc_sk_|sk-)[A-Za-z0-9_-]+/g, '[redacted]')
}

interface UpstreamError {
  type: string
  message: string
}

function parseErrorBody(body: string): UpstreamError | null {
  if (!body.trim()) return null
  try {
    const root = asRecord(JSON.parse(body) as unknown)
    const error = root ? asRecord(root.error) : null
    if (!error) return null

    // Only the structured error fields are surfaced; the raw body is never kept.
    return {
      type: typeof error.type === 'string' ? redactKeys(error.type) : '',
      message: typeof error.message === 'string' ? redactKeys(error.message) : '',
    }
  } catch {
    return null
  }
}

function unsupportedSnapshot(): UsageSnapshot {
  return { rolling: null, weekly: null, monthly: null, supported: false }
}

export class UsageClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(baseUrl: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
  }

  async fetchUsage(apiKey: string): Promise<UsageSnapshot> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await fetch(`${this.baseUrl}/usage`, {
        method: 'GET',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'x-api-key': apiKey,
          'accept': 'application/json',
          'content-type': 'application/json',
        },
        signal: controller.signal,
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        const upstreamError = parseErrorBody(body)
        // Zen keys and custom upstreams have no Go usage endpoint; this is a
        // permanent "not supported" answer, not a transient failure.
        if (response.status === 404 || (response.status === 403 && upstreamError?.type === 'EntitlementError')) {
          return unsupportedSnapshot()
        }

        const detail = upstreamError
          ? [upstreamError.type, upstreamError.message].filter(Boolean).join(': ')
          : ''
        const suffix = detail ? `: ${detail.slice(0, MAX_ERROR_LENGTH)}` : ''
        throw new Error(`Usage endpoint returned HTTP ${response.status}${suffix}`.slice(0, MAX_ERROR_LENGTH))
      }

      const payload = await response.json().catch(() => null)
      const root = asRecord(payload)
      if (!root) {
        throw new Error('Usage endpoint returned an invalid JSON payload')
      }

      // The documented shape wraps windows in "usage"; accept a bare shape too.
      const usage = asRecord(root.usage) ?? root
      const now = Date.now()
      return {
        rolling: parseWindow(usage.rolling, now),
        weekly: parseWindow(usage.weekly, now),
        monthly: parseWindow(usage.monthly, now),
        supported: true,
      }
    } catch (error) {
      const aborted = controller.signal.aborted
        || (typeof error === 'object' && error !== null
          && 'name' in error && String((error as { name?: unknown }).name) === 'AbortError')
      if (aborted) {
        throw new Error(`Usage request timed out after ${this.timeoutMs}ms`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}
