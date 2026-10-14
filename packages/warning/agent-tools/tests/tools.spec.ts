import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WarningDataCore, type WarningDataRequestContext } from '@deepseek-ai/dsh-warning-data-core'
import { createWarningAgentTools, registerWarningAgentTools } from '../src/index.ts'

const context: Omit<WarningDataRequestContext, 'signal'> = {
  taskId: 'task-tool-1',
  traceId: 'trace-tool-1',
  tenantId: 'tenant-1',
}

describe('warning agent tools', () => {
  it('exposes the adapter operations as model-facing tools and forwards cancellation', async () => {
    const execute = vi.spyOn(WarningDataCore.prototype, 'execute').mockResolvedValue({
      schemaVersion: 'v1', taskId: context.taskId, traceId: context.traceId, source: 'lps', operation: 'processes',
      queryTime: new Date(0).toISOString(), status: 'SUCCESS', rowCount: 1, truncated: false, data: [{ id: 1 }], warnings: [],
    })
    const core = new WarningDataCore()
    const tool = createWarningAgentTools({ core, requestContext: context }).get('lps_get_processes')!
    const controller = new AbortController()
    await expect(tool.execute({ query: { status: 1 } }, {
      callId: 'call-1', name: tool.name, arguments: {}, agent: undefined, signal: controller.signal,
      deferContext: () => {}, concludeTurn: () => {},
    } as never)).resolves.toMatchObject({ status: 'SUCCESS', data: [{ id: 1 }] })
    expect(execute).toHaveBeenCalledWith('lps', 'processes', { query: { status: 1 } }, expect.objectContaining({ signal: controller.signal }))
    execute.mockRestore()
  })

  it('rejects unknown allow-list entries before registering them', () => {
    const register = vi.fn()
    const ctx = { tools: { register } } as unknown as Context
    expect(() => registerWarningAgentTools(ctx, { core: new WarningDataCore(), requestContext: context }, ['unknown_tool'])).toThrow('UNKNOWN_TOOL')
    expect(register).not.toHaveBeenCalled()
  })
})
