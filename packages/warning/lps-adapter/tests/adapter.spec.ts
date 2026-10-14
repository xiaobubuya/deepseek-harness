import { describe, expect, it, vi } from 'vitest'
import { WarningDataCore, type WarningDataRequestContext } from '@deepseek-ai/dsh-warning-data-core'
import { LpsAdapter } from '../src/index.ts'

const context: WarningDataRequestContext = {
  taskId: 'task-lps-1',
  traceId: 'trace-lps-1',
  tenantId: 'tenant-1',
  metadata: { requestId: 'request-lps-1' },
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

describe('LpsAdapter', () => {
  it('queries the existing read-only admin endpoints and forwards request context', async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(requestUrl(input))
      expect(url.pathname).toBe('/lps-admin-server/process/queryAll')
      expect(url.searchParams.get('status')).toBe('1')
      const headers = new Headers(init?.headers)
      expect(headers.get('X-Api-Key')).toBe('lps-key')
      expect(headers.get('X-Request-Id')).toBe('request-lps-1')
      expect(headers.get('X-Agent-Task-Id')).toBe('task-lps-1')
      return response([{ id: 101, datasetId: 12 }])
    })
    const core = new WarningDataCore({ sourcePolicies: { lps: { requireTenant: true, maxRows: 10 } } })
    core.register(new LpsAdapter({ baseUrl: 'https://lps.example/lps-admin-server', apiKey: 'lps-key', fetch }))

    await expect(core.execute('lps', 'processes', { query: { status: 1 } }, context)).resolves.toMatchObject({
      status: 'SUCCESS', rowCount: 1, data: [{ id: 101 }],
    })
  })

  it('supports configurable lineage endpoint and rejects missing identifiers', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(requestUrl(input))
      expect(url.pathname).toBe('/agent/lineage')
      expect(url.searchParams.get('processId')).toBe('101')
      return response({ code: 200, data: { process: { id: 101 }, metrics: [] } })
    })
    const adapter = new LpsAdapter({ baseUrl: 'https://lps.example', paths: { lineage: '/agent/lineage' }, fetch })
    const core = new WarningDataCore()
    core.register(adapter)

    await expect(core.execute('lps', 'lineage', { processId: 101 }, context)).resolves.toMatchObject({ status: 'SUCCESS', data: { process: { id: 101 } } })
    await expect(core.execute('lps', 'lineage', {}, context)).resolves.toMatchObject({ status: 'FAILED', error: { code: 'INVALID_INPUT' } })
  })

  it('maps upstream HTTP failures to retryable errors', async () => {
    const fetch = vi.fn(async () => response({ code: 503 }, 503))
    const core = new WarningDataCore()
    core.register(new LpsAdapter({ baseUrl: 'https://lps.example', fetch }))
    await expect(core.execute('lps', 'alerts', undefined, context)).resolves.toMatchObject({
      status: 'FAILED', error: { code: 'UPSTREAM_HTTP_503', retryable: true },
    })
  })
})
