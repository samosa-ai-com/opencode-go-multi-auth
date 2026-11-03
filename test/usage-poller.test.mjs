import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UsagePoller } from '../dist/usage/usage-poller.js'

function makeKey(id, alias, key = `sk-${id}`) {
  return { id, alias, key }
}

function snapshot(usedPercent) {
  return {
    rolling: { usedPercent, status: 'ok', resetsAt: null },
    weekly: null,
    monthly: null,
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(5)
  }
  throw new Error('condition was not met before timeout')
}

test('polls a key added after start when the router booted with zero keys', async () => {
  const keys = []
  const calls = []
  const client = {
    async fetchUsage(apiKey) {
      calls.push(apiKey)
      return snapshot(5)
    },
  }
  const poller = new UsagePoller(client, {
    getKeys: () => keys,
    intervalMs: 15_000,
    syncIntervalMs: 10,
    staggerMs: 0,
  })

  poller.start()
  try {
    await sleep(30)
    assert.equal(calls.length, 0)

    keys.push(makeKey('id-added', 'Late'))
    await waitFor(() => calls.length > 0)
    assert.deepEqual(calls, [keys[0].key])
    assert.equal(poller.getUsage('id-added').rolling.usedPercent, 5)
  } finally {
    poller.stop()
  }
})

test('keeps identical aliases isolated by key id', async () => {
  const first = makeKey('id-1', 'Same', 'sk-one')
  const second = makeKey('id-2', 'Same', 'sk-two')
  const client = {
    async fetchUsage(apiKey) {
      return snapshot(apiKey === first.key ? 10 : 90)
    },
  }
  const poller = new UsagePoller(client, {
    getKeys: () => [first, second],
    intervalMs: 15_000,
  })

  await poller.pollKey(first)
  await poller.pollKey(second)

  assert.equal(poller.getUsage('id-1').rolling.usedPercent, 10)
  assert.equal(poller.getUsage('id-2').rolling.usedPercent, 90)
  assert.equal(poller.getUsage('Same'), null)
})

test('merges a partial payload without erasing known windows', async () => {
  let call = 0
  const client = {
    async fetchUsage() {
      call += 1
      if (call === 1) {
        return {
          rolling: { usedPercent: 10, status: 'ok', resetsAt: null },
          weekly: { usedPercent: 20, status: 'ok', resetsAt: null },
          monthly: { usedPercent: 30, status: 'ok', resetsAt: null },
        }
      }
      return snapshot(50)
    },
  }
  const key = makeKey('id-merge', 'Merge')
  const poller = new UsagePoller(client, {
    getKeys: () => [key],
    intervalMs: 15_000,
  })

  await poller.pollKey(key)
  await poller.pollKey(key)

  const usage = poller.getUsage(key.id)
  assert.equal(usage.rolling.usedPercent, 50)
  assert.equal(usage.weekly.usedPercent, 20)
  assert.equal(usage.monthly.usedPercent, 30)
  assert.equal(usage.error, null)
})
