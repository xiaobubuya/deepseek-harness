import { describe, expect, it } from 'vitest'
import { assessWarningDataCompleteness, WarningDataCore, WarningDataError, type WarningDataAdapter, type WarningDataRequestContext, type WarningDataResult } from '../src/index.ts'

const context: WarningDataRequestContext = { taskId: 'task-1', traceId: 'trace-1', tenantId: 'tenant-1' }

function adapter(overrides: Partial<WarningDataAdapter> = {}): WarningDataAdapter {
  return {
    source: 'doris',
    operations: ['detail.query'],
    async execute() {
      return { data: [{ id: 1 }], watermark: '2026-09-28T10:00:00Z' }
    },
    ...overrides,
  }
}

describe('WarningDataCore', () => {
  it('returns a canonical result envelope and applies row limits', async () => {
    const core = new WarningDataCore({ defaultMaxRows: 2, now: () => Date.parse('2026-09-28T10:00:00Z') })
    core.register(adapter({ execute: async () => ({ data: [{ id: 1 }, { id: 2 }, { id: 3 }] }) }))

    await expect(core.execute('doris', 'detail.query', {}, context)).resolves.toMatchObject({
      schemaVersion: 'v1', taskId: 'task-1', traceId: 'trace-1', source: 'doris', operation: 'detail.query',
      status: 'PARTIAL', rowCount: 2, truncated: true, data: [{ id: 1 }, { id: 2 }],
    })
  })

  it('enforces operation, tenant, and action-grant policies', async () => {
    const core = new WarningDataCore({ sourcePolicies: {
      lps: { requireTenant: true, allowedOperations: ['process.get'] },
      popo: { access: 'read-write', requiredGrant: 'popoTeam' },
    } })
    core.register(adapter({ source: 'lps', operations: ['process.get'] }))
    core.register(adapter({ source: 'popo', operations: ['team.create'] }))

    await expect(core.execute('lps', 'metric.list', {}, context)).resolves.toMatchObject({ status: 'FAILED', error: { code: 'OPERATION_NOT_ALLOWED' } })
    await expect(core.execute('lps', 'process.get', {}, context, 'write')).resolves.toMatchObject({ status: 'FAILED', error: { code: 'WRITE_NOT_ALLOWED' } })
    await expect(core.execute('popo', 'team.create', {}, context, 'write')).resolves.toMatchObject({ status: 'FAILED', error: { code: 'ACTION_GRANT_REQUIRED' } })
    await expect(core.execute('popo', 'team.create', {}, { ...context, actionGrant: { popoTeam: true } }, 'write')).resolves.toMatchObject({ status: 'SUCCESS' })
  })

  it('normalizes timeout and adapter errors without leaking exception details', async () => {
    const core = new WarningDataCore({ defaultTimeoutMs: 5 })
    core.register(adapter({ execute: async ({ context: requestContext }) => {
      await new Promise<void>((_resolve, reject) => {
        requestContext.signal?.addEventListener('abort', () => { reject(new Error('secret database password')) }, { once: true })
      })
      return { data: [] }
    } }))
    await expect(core.execute('doris', 'detail.query', {}, context)).resolves.toMatchObject({
      status: 'FAILED', error: { code: 'TIMEOUT', message: 'data source timed out: doris.detail.query' },
    })

    const errorCore = new WarningDataCore()
    errorCore.register(adapter({ execute: async () => { throw new WarningDataError('UPSTREAM_429', 'upstream is busy', true) } }))
    await expect(errorCore.execute('doris', 'detail.query', {}, context)).resolves.toMatchObject({
      status: 'FAILED', error: { code: 'UPSTREAM_429', message: 'upstream is busy', retryable: true },
    })
  })

  it('assesses cross-source completeness from canonical results', () => {
    const result = (source: WarningDataResult['source'], status: WarningDataResult['status'], watermark?: string): WarningDataResult => ({
      schemaVersion: 'v1', taskId: 'task-1', traceId: 'trace-1', source, operation: 'query', status,
      queryTime: '2026-09-28T10:00:00Z', rowCount: 1, truncated: false, data: [], warnings: [],
      ...(watermark === undefined ? {} : { watermark }),
    })
    const report = assessWarningDataCompleteness([
      result('lps', 'SUCCESS', '2026-09-28T10:00:00Z'),
      result('doris', 'PARTIAL'),
    ], { requiredSources: ['lps', 'doris', 'ntsdb'], requireWatermark: true })
    expect(report).toMatchObject({
      complete: false, status: 'PARTIAL', missingSources: ['ntsdb'], partialSources: ['doris'],
      missingWatermarkSources: ['doris', 'ntsdb'],
    })
  })
})
