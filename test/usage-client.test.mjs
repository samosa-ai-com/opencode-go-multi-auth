import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { UsageClient } from '../dist/usage/usage-client.js'

async function withServer(response, callback) {
  let captured = null
  const server = http.createServer((req, res) => {
    captured = { url: req.url, headers: req.headers }
    res.writeHead(response.status, { 'content-type': 'application/json' })
    res.end(response.body)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await callback(new UsageClient(`http://127.0.0.1:${port}/zen/go/v1`), () => captured)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('parses a normal usage payload', async () => {
  const body = JSON.stringify({
    usage: {
      rolling: { status: 'ok', percent: 12, resetsAt: '2026-08-22T19:00:00Z' },
      weekly: { status: 'ok', percent: 34, resetsAt: '2026-08-25T00:00:00Z' },
      monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-09-01T00:00:00Z' },
    },
  })

  await withServer({ status: 200, body }, async (client) => {
    const usage = await client.fetchUsage('test-key')
    assert.deepEqual(usage, {
      rolling: { usedPercent: 12, status: 'ok', resetsAt: '2026-08-22T19:00:00.000Z' },
      weekly: { usedPercent: 34, status: 'ok', resetsAt: '2026-08-25T00:00:00.000Z' },
      monthly: { usedPercent: 100, status: 'rate-limited', resetsAt: '2026-09-01T00:00:00.000Z' },
      supported: true,
    })
  })
})

test('converts legacy resetInSec to an ISO timestamp', async () => {
  const body = JSON.stringify({
    usage: {
      rolling: { status: 'ok', percent: 5, resetInSec: 3600 },
      weekly: { status: 'ok', percent: 6, resetInSec: 7200 },
      monthly: { status: 'ok', percent: 7, resetInSec: 10800 },
    },
  })

  await withServer({ status: 200, body }, async (client) => {
    const before = Date.now()
    const usage = await client.fetchUsage('test-key')
    const after = Date.now()

    for (const [window, seconds] of [[usage.rolling, 3600], [usage.weekly, 7200], [usage.monthly, 10800]]) {
      const resetsAt = Date.parse(window.resetsAt)
      assert.ok(resetsAt >= before + seconds * 1000 - 1000)
      assert.ok(resetsAt <= after + seconds * 1000 + 1000)
    }
  })
})

test('keeps missing windows null', async () => {
  const body = JSON.stringify({
    usage: {
      rolling: { status: 'rate-limited', percent: 87, resetsAt: '2026-08-22T19:00:00Z' },
    },
  })

  await withServer({ status: 200, body }, async (client) => {
    const usage = await client.fetchUsage('test-key')
    assert.equal(usage.rolling.usedPercent, 87)
    assert.equal(usage.weekly, null)
    assert.equal(usage.monthly, null)
  })
})

test('clamps out-of-range percentages', async () => {
  const body = JSON.stringify({
    usage: {
      rolling: { status: 'ok', percent: 150, resetsAt: null },
      weekly: { status: 'ok', percent: -5, resetsAt: null },
      monthly: { status: 'ok', usedPercent: 42, resetsAt: null },
    },
  })

  await withServer({ status: 200, body }, async (client) => {
    const usage = await client.fetchUsage('test-key')
    assert.equal(usage.rolling.usedPercent, 100)
    assert.equal(usage.weekly.usedPercent, 0)
    assert.equal(usage.monthly.usedPercent, 42)
  })
})

test('treats 403 EntitlementError as unsupported', async () => {
  const body = JSON.stringify({
    error: { type: 'EntitlementError', message: 'no Go subscription for this account' },
  })

  await withServer({ status: 403, body }, async (client) => {
    const usage = await client.fetchUsage('zen-key')
    assert.deepEqual(usage, { rolling: null, weekly: null, monthly: null, supported: false })
  })
})

test('treats 404 as unsupported', async () => {
  await withServer({ status: 404, body: '' }, async (client) => {
    const usage = await client.fetchUsage('custom-key')
    assert.deepEqual(usage, { rolling: null, weekly: null, monthly: null, supported: false })
  })
})

test('still throws for a 403 that is not EntitlementError', async () => {
  const body = JSON.stringify({
    error: { type: 'RateLimitError', message: 'too many requests' },
  })

  await withServer({ status: 403, body }, async (client) => {
    await assert.rejects(client.fetchUsage('rate-limited-key'), (error) => {
      assert.match(error.message, /403/)
      assert.match(error.message, /RateLimitError/)
      return true
    })
  })
})

test('still reports HTTP status and upstream error detail for 401', async () => {
  const body = JSON.stringify({
    error: { type: 'AuthError', message: 'invalid API key' },
  })

  await withServer({ status: 401, body }, async (client) => {
    await assert.rejects(client.fetchUsage('bad-key'), (error) => {
      assert.match(error.message, /401/)
      assert.match(error.message, /AuthError/)
      assert.ok(error.message.length <= 200)
      return true
    })
  })
})

test('sends the proxy auth headers to the usage endpoint', async () => {
  const body = JSON.stringify({ usage: {} })

  await withServer({ status: 200, body }, async (client, getCaptured) => {
    await client.fetchUsage('test-key')
    const request = getCaptured()
    assert.equal(request.url, '/zen/go/v1/usage')
    assert.equal(request.headers.authorization, 'Bearer test-key')
    assert.equal(request.headers['x-api-key'], 'test-key')
    assert.equal(request.headers.accept, 'application/json')
    assert.equal(request.headers['content-type'], 'application/json')
  })
})
