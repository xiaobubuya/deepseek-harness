import { describe, expect, it, vi } from 'vitest'
import { WarningDataCore, type WarningDataRequestContext } from '@deepseek-ai/dsh-warning-data-core'
import { NtsdbAdapter } from '../src/index.ts'

const context: WarningDataRequestContext = { taskId: 'task-ntsdb-1', traceId: 'trace-ntsdb-1', tenantId: 'tenant-1' }

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

describe('NtsdbAdapter', () => {
  it('queries InfluxDB and flattens tagged series with a watermark', async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(requestUrl(input))
      expect(url.pathname).toBe('/query')
      expect(url.searchParams.get('db')).toBe('vcloud_alert')
      expect(url.searchParams.get('q')).toContain('time > now() - 10m')
      const headers = new Headers(init?.headers)
      expect(headers.get('X-Agent-Task-Id')).toBe('task-ntsdb-1')
      return response({ results: [{ series: [{ name: 'IM_succ_sum', columns: ['time', 'value'], values: [['2026-09-28T10:00:00Z', 3]], tags: { appkey: 'demo' } }] }] })
    })
    const core = new WarningDataCore({ sourcePolicies: { ntsdb: { requireTenant: true, maxRows: 10 } } })
    core.register(new NtsdbAdapter({ endpoints: { console: 'http://ntsdb.example:8186' }, fetch }))
    await expect(core.execute('ntsdb', 'query', {
      datasource: 'console', database: 'vcloud_alert', query: 'SELECT * FROM "IM_succ_sum" WHERE time > now() - 10m LIMIT 1',
    }, context)).resolves.toMatchObject({ status: 'SUCCESS', rowCount: 1, watermark: '2026-09-28T10:00:00Z', data: [{ appkey: 'demo', value: 3, _measurement: 'IM_succ_sum' }] })
  })

  it('rejects unsafe, unbounded, and over-wide queries before transport', async () => {
    const fetch = vi.fn()
    const core = new WarningDataCore()
    core.register(new NtsdbAdapter({ endpoints: { console: 'http://ntsdb.example:8186' }, fetch }))
    for (const query of ['DELETE FROM x', 'SELECT * FROM x', 'SELECT * FROM x WHERE time > now() - 8d', 'SELECT * FROM x WHERE time > now() - 1m;']) {
      await expect(core.execute('ntsdb', 'query', { datasource: 'console', database: 'db', query }, context)).resolves.toMatchObject({ status: 'FAILED', error: { code: 'INVALID_QUERY' } })
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('truncates rows according to core constraints and preserves upstream errors', async () => {
    const fetch = vi.fn(async () => response({ results: [{ series: [{ columns: ['time', 'value'], values: [['2026-09-28T10:00:00Z', 1], ['2026-09-28T10:01:00Z', 2]] }] }] }))
    const core = new WarningDataCore({ sourcePolicies: { ntsdb: { maxRows: 1 } } })
    core.register(new NtsdbAdapter({ endpoints: { outer: 'http://ntsdb.example:8086' }, fetch }))
    await expect(core.execute('ntsdb', 'query', { datasource: 'outer', database: 'db', query: 'SELECT * FROM x WHERE time > now() - 1m' }, context)).resolves.toMatchObject({ status: 'PARTIAL', rowCount: 1, truncated: true, data: [{ value: 1 }] })

    const failedFetch = vi.fn(async () => response({ results: [{ error: 'measurement not found' }] }))
    const failedCore = new WarningDataCore()
    failedCore.register(new NtsdbAdapter({ endpoints: { outer: 'http://ntsdb.example:8086' }, fetch: failedFetch }))
    await expect(failedCore.execute('ntsdb', 'query', { datasource: 'outer', database: 'db', query: 'SELECT * FROM x WHERE time > now() - 1m' }, context)).resolves.toMatchObject({ status: 'FAILED', error: { code: 'UPSTREAM_QUERY_ERROR' } })
  })
})
