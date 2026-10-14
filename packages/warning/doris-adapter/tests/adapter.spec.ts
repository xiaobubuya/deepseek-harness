import { describe, expect, it, vi } from 'vitest'
import { WarningDataCore, type WarningDataRequestContext } from '@deepseek-ai/dsh-warning-data-core'
import { DorisAdapter } from '../src/index.ts'

const context: WarningDataRequestContext = {
  taskId: 'task-doris-1',
  traceId: 'trace-doris-1',
  tenantId: 'tenant-1',
  metadata: { requestId: 'request-1' },
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

describe('DorisAdapter', () => {
  it('calls the protected admin API and maps a query result', async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input)
      expect(url).toBe('https://lps-admin.example/doris-skill/execute')
      expect(init?.method).toBe('POST')
      const headers = new Headers(init?.headers)
      expect(headers.get('X-Api-Key')).toBe('agent-key')
      expect(headers.get('X-Request-Id')).toBe('request-1')
      expect(headers.get('X-Agent-Task-Id')).toBe('task-doris-1')
      const body = init?.body
      expect(typeof body).toBe('string')
      if (typeof body !== 'string') throw new Error('expected JSON request body')
      expect(JSON.parse(body)).toEqual({
        dbName: 'lps_doris_bucket',
        sql: "SELECT event_time, appkey FROM sre_im_monitor WHERE event_time >= '2026-09-28 10:00:00' LIMIT 10",
      })
      return response({ code: 200, data: { data: [{ event_time: '2026-09-28 10:00:00', appkey: 'redacted' }], rowCount: 1, truncated: false, execTimeMs: 12 } })
    })
    const core = new WarningDataCore({ sourcePolicies: { doris: { requireTenant: true, maxRows: 10 } } })
    core.register(new DorisAdapter({ baseUrl: 'https://lps-admin.example/', apiKey: 'agent-key', fetch }))

    await expect(core.execute('doris', 'query', {
      sql: "SELECT event_time, appkey FROM sre_im_monitor WHERE event_time >= '2026-09-28 10:00:00' LIMIT 10",
    }, context)).resolves.toMatchObject({
      status: 'SUCCESS', source: 'doris', rowCount: 1, data: [{ appkey: 'redacted' }],
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('rejects unsafe or unbounded SQL before making a network request', async () => {
    const fetch = vi.fn()
    const core = new WarningDataCore()
    core.register(new DorisAdapter({ baseUrl: 'https://lps-admin.example', apiKey: 'agent-key', fetch }))

    await expect(core.execute('doris', 'query', { sql: 'DELETE FROM sre_im_monitor' }, context)).resolves.toMatchObject({
      status: 'FAILED', error: { code: 'INVALID_SQL' },
    })
    await expect(core.execute('doris', 'query', { sql: 'WITH recent AS (SELECT * FROM sre_im_monitor) SELECT * FROM recent' }, context)).resolves.toMatchObject({
      status: 'FAILED', error: { code: 'INVALID_SQL' },
    })
    await expect(core.execute('doris', 'query', { sql: 'SELECT * FROM sre_im_monitor LIMIT 10' }, context)).resolves.toMatchObject({
      status: 'FAILED', error: { code: 'INVALID_SQL' },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('normalizes upstream failures and supports schema endpoints', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input)
      if (url.endsWith('/doris-skill/tables')) return response({ code: 200, data: { tables: [{ tableName: 'sre_im_monitor' }] } })
      if (url.endsWith('/doris-skill/tables/sre_im_monitor')) return response({ code: 200, data: { tableName: 'sre_im_monitor', columns: [] } })
      return response({ code: 503 }, 503)
    })
    const adapter = new DorisAdapter({ baseUrl: 'https://lps-admin.example', apiKey: 'agent-key', fetch })
    const core = new WarningDataCore()
    core.register(adapter)

    await expect(core.execute('doris', 'tables', {}, context)).resolves.toMatchObject({ status: 'SUCCESS', data: { tables: [{ tableName: 'sre_im_monitor' }] } })
    await expect(core.execute('doris', 'tableSchema', { tableName: 'sre_im_monitor' }, context)).resolves.toMatchObject({ status: 'SUCCESS', data: { tableName: 'sre_im_monitor' } })
    await expect(core.execute('doris', 'query', { sql: 'SELECT event_time FROM sre_im_monitor WHERE event_time > 0' }, context)).resolves.toMatchObject({
      status: 'FAILED', error: { code: 'UPSTREAM_HTTP_503', retryable: true },
    })
  })
})
