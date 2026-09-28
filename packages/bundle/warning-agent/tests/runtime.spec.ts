import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WarningAgentRuntime, internals, type Config, type WarningAgentDelivery } from '../src/runtime.ts'

const servers: WarningAgentRuntime[] = []
const sessionDirs: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  await Promise.all(sessionDirs.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

async function config(overrides: Partial<Config> = {}): Promise<Config> {
  const sessionDir = await mkdtemp(join(tmpdir(), 'warning-agent-'))
  sessionDirs.push(sessionDir)
  return {
    host: '127.0.0.1',
    port: 0,
    sharedSecret: 'secret',
    gatewayCallbackUrl: '',
    callbackTimeoutMs: 1000,
    callbackRetryAttempts: 3,
    callbackRetryBackoffMs: 1,
    sessionDir,
    maxConcurrentTasks: 4,
    taskTimeoutMs: 60_000,
    retentionMs: 7 * 24 * 60 * 60 * 1000,
    ...overrides,
  }
}

function delivery(overrides: Partial<WarningAgentDelivery> = {}): WarningAgentDelivery {
  return {
    schemaVersion: 'v1', taskId: 'task-1', incidentId: 'incident-1', taskType: 'investigate',
    revision: 1, attempt: 1, priority: 'P1', deadlineAt: '2099-01-01T00:00:00.000Z',
    allowedTools: [], context: {}, actionGrant: { popoTeam: false }, ...overrides,
  }
}

function signedHeaders(method: string, path: string, body: string, secret: string, now: number, nonce = 'nonce-1'): Record<string, string> {
  const timestamp = String(now)
  const message = `${method}\n${path}\n${timestamp}\n${nonce}\n${body}`
  const signature = createHmac('sha256', secret).update(message).digest('hex')
  return {
    'content-type': 'application/json',
    'x-warning-agent-timestamp': timestamp,
    'x-warning-agent-nonce': nonce,
    'x-warning-agent-signature': `sha256=${signature}`,
  }
}

function baseUrl(runtime: WarningAgentRuntime): string {
  const address = (runtime as unknown as { server: { address(): { port: number } } }).server.address()
  return `http://127.0.0.1:${address.port}`
}

async function submit(runtime: WarningAgentRuntime, value: WarningAgentDelivery, now: number, nonce = 'nonce-1'): Promise<Response> {
  const body = JSON.stringify(value)
  return fetch(`${baseUrl(runtime)}${internals.DELIVERY_PATH}`, {
    method: 'POST', headers: signedHeaders('POST', internals.DELIVERY_PATH, body, 'secret', now, nonce), body,
  })
}

describe('warning-agent runtime ingress', () => {
  it('admits signed deliveries and returns deterministic ids for duplicates', async () => {
    const now = 1_700_000_000_000
    const runtime = new WarningAgentRuntime(await config(), () => now)
    servers.push(runtime)
    await runtime.listen()
    const first = await submit(runtime, delivery(), now)
    const firstJson = await first.json() as { sessionId: string; workflowId: string; duplicate: boolean }
    const duplicateJson = await (await submit(runtime, delivery(), now, 'nonce-2')).json() as { sessionId: string; workflowId: string; duplicate: boolean }
    const retryJson = await (await submit(runtime, delivery({ attempt: 2 }), now, 'nonce-3')).json() as { sessionId: string; workflowId: string }
    expect(first.status).toBe(202)
    expect(firstJson.duplicate).toBe(false)
    expect(duplicateJson).toMatchObject({ duplicate: true, sessionId: firstJson.sessionId, workflowId: firstJson.workflowId })
    expect(retryJson.sessionId).toBe(firstJson.sessionId)
    expect(retryJson.workflowId).not.toBe(firstJson.workflowId)
  })

  it('restores idempotency records from the JSONL volume', async () => {
    const now = 1_700_000_000_000
    const sharedConfig = await config()
    const first = new WarningAgentRuntime(sharedConfig, () => now)
    servers.push(first)
    await first.listen()
    const acceptedJson = await (await submit(first, delivery(), now)).json() as { sessionId: string; workflowId: string }
    await first.close()
    servers.splice(servers.indexOf(first), 1)
    const restored = new WarningAgentRuntime(sharedConfig, () => now)
    servers.push(restored)
    await restored.listen()
    await expect((await submit(restored, delivery(), now, 'nonce-restored')).json()).resolves.toMatchObject({
      duplicate: true, sessionId: acceptedJson.sessionId, workflowId: acceptedJson.workflowId,
    })
  })

  it('restores every attempt independently instead of only the last session line', async () => {
    const now = 1_700_000_000_000
    const sharedConfig = await config()
    const first = new WarningAgentRuntime(sharedConfig, () => now)
    servers.push(first)
    await first.listen()
    await submit(first, delivery({ attempt: 1 }), now, 'attempt-1')
    await submit(first, delivery({ attempt: 2 }), now, 'attempt-2')
    await first.close()
    servers.splice(servers.indexOf(first), 1)

    const restored = new WarningAgentRuntime(sharedConfig, () => now)
    servers.push(restored)
    await restored.listen()
    await expect((await submit(restored, delivery({ attempt: 1 }), now, 'restored-1')).json()).resolves.toMatchObject({ duplicate: true, attempt: 1 })
    await expect((await submit(restored, delivery({ attempt: 2 }), now, 'restored-2')).json()).resolves.toMatchObject({ duplicate: true, attempt: 2 })
  })

  it('re-arms the timeout for an active task restored after restart', async () => {
    const now = 1_700_000_000_000
    const sharedConfig = await config({ taskTimeoutMs: 30 })
    const first = new WarningAgentRuntime(sharedConfig, () => now)
    servers.push(first)
    await first.listen()
    await submit(first, delivery(), now, 'timeout-1')
    await first.close()
    servers.splice(servers.indexOf(first), 1)

    const restored = new WarningAgentRuntime(sharedConfig, () => now)
    servers.push(restored)
    await restored.listen()
    expect(restored.activeTaskCount).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(restored.activeTaskCount).toBe(0)
  })

  it('returns 429 at capacity and supports idempotent cancellation', async () => {
    const now = 1_700_000_000_000
    const runtime = new WarningAgentRuntime(await config({ maxConcurrentTasks: 1 }), () => now)
    servers.push(runtime)
    await runtime.listen()
    expect((await submit(runtime, delivery(), now)).status).toBe(202)
    const busy = await submit(runtime, delivery({ taskId: 'task-2' }), now, 'nonce-2')
    expect(busy.status).toBe(429)
    expect(busy.headers.get('retry-after')).toBe('5')
    const path = '/internal/warning-agent/v1/tasks/task-1/cancel'
    const body = JSON.stringify({ revision: 1, attempt: 1, reason: 'operator_cancelled' })
    const firstCancel = await fetch(`${baseUrl(runtime)}${path}`, { method: 'POST', body, headers: signedHeaders('POST', path, body, 'secret', now, 'cancel-1') })
    const duplicateCancel = await fetch(`${baseUrl(runtime)}${path}`, { method: 'POST', body, headers: signedHeaders('POST', path, body, 'secret', now, 'cancel-2') })
    await expect(firstCancel.json()).resolves.toMatchObject({ status: 'CANCELLED', duplicate: false })
    await expect(duplicateCancel.json()).resolves.toMatchObject({ status: 'CANCELLED', duplicate: true })
  })

  it('completes the exact revision and attempt without releasing another attempt', async () => {
    const now = 1_700_000_000_000
    const runtime = new WarningAgentRuntime(await config(), () => now)
    servers.push(runtime)
    await runtime.listen()
    expect((await submit(runtime, delivery(), now)).status).toBe(202)
    expect((await submit(runtime, delivery({ attempt: 2 }), now, 'nonce-2')).status).toBe(202)
    expect(runtime.activeTaskCount).toBe(2)

    runtime.complete('task-1', 1, 2, 'SUCCEEDED')

    expect(runtime.activeTaskCount).toBe(1)
    await expect((await submit(runtime, delivery({ attempt: 2 }), now, 'nonce-3')).json()).resolves.toMatchObject({
      duplicate: true,
      attempt: 2,
    })
  })

  it('rejects invalid, replayed, and expired signatures', async () => {
    const now = 1_700_000_000_000
    const runtime = new WarningAgentRuntime(await config(), () => now)
    servers.push(runtime)
    await runtime.listen()
    const body = JSON.stringify(delivery())
    const url = `${baseUrl(runtime)}${internals.DELIVERY_PATH}`
    expect((await fetch(url, { method: 'POST', body, headers: signedHeaders('POST', internals.DELIVERY_PATH, body, 'wrong', now) })).status).toBe(401)
    const validHeaders = signedHeaders('POST', internals.DELIVERY_PATH, body, 'secret', now)
    expect((await fetch(url, { method: 'POST', body, headers: validHeaders })).status).toBe(202)
    expect((await fetch(url, { method: 'POST', body, headers: validHeaders })).status).toBe(401)
    const expired = signedHeaders('POST', internals.DELIVERY_PATH, body, 'secret', now - internals.SIGNATURE_WINDOW_MS - 1, 'nonce-3')
    expect((await fetch(url, { method: 'POST', body, headers: expired })).status).toBe(401)
  })

  it('exposes health and readiness', async () => {
    const runtime = new WarningAgentRuntime(await config())
    servers.push(runtime)
    await runtime.listen()
    expect((await fetch(`${baseUrl(runtime)}/health`)).status).toBe(200)
    expect((await fetch(`${baseUrl(runtime)}/ready`)).status).toBe(200)
  })
})
