/** Shared contracts and policy enforcement for warning-center data access. */

export const WARNING_DATA_SCHEMA_VERSION = 'v1' as const

export type WarningDataSource = 'lps' | 'doris' | 'ntsdb' | 'popo' | (string & {})
export type WarningDataAccess = 'read' | 'write'
export type WarningDataStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED'

export interface WarningDataActionGrant {
  readonly popoTeam?: boolean
}

export interface WarningDataRequestContext {
  readonly taskId: string
  readonly traceId: string
  readonly tenantId?: string
  readonly actor?: string
  readonly deadlineAt?: string
  readonly signal?: AbortSignal
  readonly actionGrant?: WarningDataActionGrant
  readonly metadata?: Readonly<Record<string, string>>
}

export interface WarningDataConstraints {
  readonly timeoutMs: number
  readonly maxRows: number
}

export interface WarningDataAdapterRequest<TInput = unknown> {
  readonly source: WarningDataSource
  readonly operation: string
  readonly input: TInput
  readonly context: WarningDataRequestContext
  readonly constraints: WarningDataConstraints
}

export interface WarningDataAdapterResponse<TData = unknown> {
  readonly status?: Exclude<WarningDataStatus, 'FAILED'>
  readonly data: TData
  readonly rowCount?: number
  readonly watermark?: string
  readonly warnings?: readonly string[]
}

export interface WarningDataErrorInfo {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

export interface WarningDataResult<TData = unknown> {
  readonly schemaVersion: typeof WARNING_DATA_SCHEMA_VERSION
  readonly taskId: string
  readonly traceId: string
  readonly source: WarningDataSource
  readonly operation: string
  readonly status: WarningDataStatus
  readonly queryTime: string
  readonly watermark?: string
  readonly rowCount: number
  readonly truncated: boolean
  readonly data: TData | null
  readonly warnings: readonly string[]
  readonly error?: WarningDataErrorInfo
}

export interface WarningDataAdapter<TInput = unknown, TData = unknown> {
  readonly source: WarningDataSource
  readonly operations: readonly string[]
  execute(request: WarningDataAdapterRequest<TInput>): Promise<WarningDataAdapterResponse<TData>>
}

export interface WarningDataSourcePolicy {
  readonly access?: 'read' | 'read-write'
  readonly timeoutMs?: number
  readonly maxRows?: number
  readonly allowedOperations?: readonly string[]
  readonly requireTenant?: boolean
  readonly requiredGrant?: keyof WarningDataActionGrant
}

export interface WarningDataCoreConfig {
  readonly defaultTimeoutMs?: number
  readonly defaultMaxRows?: number
  readonly sourcePolicies?: Readonly<Record<string, WarningDataSourcePolicy>>
  readonly now?: () => number
}

export interface WarningDataCompletenessOptions {
  readonly requiredSources: readonly WarningDataSource[]
  readonly requireWatermark?: boolean
}

export interface WarningDataCompletenessReport {
  readonly complete: boolean
  readonly status: 'COMPLETE' | 'PARTIAL' | 'FAILED'
  readonly requiredSources: readonly WarningDataSource[]
  readonly missingSources: readonly WarningDataSource[]
  readonly failedSources: readonly WarningDataSource[]
  readonly partialSources: readonly WarningDataSource[]
  readonly missingWatermarkSources: readonly WarningDataSource[]
  readonly warnings: readonly string[]
}

export class WarningDataError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = 'WarningDataError'
    this.code = code
    this.retryable = retryable
  }
}

/** Assess whether a task has complete, usable coverage across its sources. */
export function assessWarningDataCompleteness(
  results: readonly WarningDataResult[],
  options: WarningDataCompletenessOptions,
): WarningDataCompletenessReport {
  const requiredSources = [...new Set(options.requiredSources)]
  const bySource = new Map<string, WarningDataResult[]>()
  for (const result of results) {
    const existing = bySource.get(result.source) ?? []
    existing.push(result)
    bySource.set(result.source, existing)
  }
  const missingSources = requiredSources.filter(source => !bySource.has(source))
  const failedSources = requiredSources.filter(source => (bySource.get(source) ?? []).some(result => result.status === 'FAILED'))
  const partialSources = requiredSources.filter(source => (bySource.get(source) ?? []).some(result => result.status === 'PARTIAL'))
  const missingWatermarkSources = options.requireWatermark === true
    ? requiredSources.filter((source) => {
      const sourceResults = bySource.get(source) ?? []
      return sourceResults.length === 0 || sourceResults.every(result => result.watermark === undefined)
    })
    : []
  const warnings: string[] = []
  if (missingSources.length > 0) warnings.push(`missing sources: ${missingSources.join(', ')}`)
  if (failedSources.length > 0) warnings.push(`failed sources: ${failedSources.join(', ')}`)
  if (partialSources.length > 0) warnings.push(`partial sources: ${partialSources.join(', ')}`)
  if (missingWatermarkSources.length > 0) warnings.push(`missing watermarks: ${missingWatermarkSources.join(', ')}`)
  const failed = failedSources.length > 0
  const complete = warnings.length === 0
  return {
    complete,
    status: failed ? 'FAILED' : complete ? 'COMPLETE' : 'PARTIAL',
    requiredSources,
    missingSources,
    failedSources,
    partialSources,
    missingWatermarkSources,
    warnings,
  }
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_ROWS = 1_000

/**
 * Registry and execution boundary shared by the Warning Center and Harness
 * plugins. Adapters own transport details; this class owns policy and the
 * canonical result envelope.
 */
export class WarningDataCore {
  private readonly adapters = new Map<string, WarningDataAdapter>()
  private readonly config: Required<Pick<WarningDataCoreConfig, 'defaultTimeoutMs' | 'defaultMaxRows'>> & WarningDataCoreConfig

  constructor(config: WarningDataCoreConfig = {}) {
    this.config = {
      defaultTimeoutMs: config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      defaultMaxRows: config.defaultMaxRows ?? DEFAULT_MAX_ROWS,
      ...config,
    }
    if (!Number.isInteger(this.config.defaultTimeoutMs) || this.config.defaultTimeoutMs <= 0) {
      throw new WarningDataError('INVALID_CONFIG', 'defaultTimeoutMs must be a positive integer')
    }
    if (!Number.isInteger(this.config.defaultMaxRows) || this.config.defaultMaxRows <= 0) {
      throw new WarningDataError('INVALID_CONFIG', 'defaultMaxRows must be a positive integer')
    }
  }

  register(adapter: WarningDataAdapter): () => void {
    if (this.adapters.has(adapter.source)) {
      throw new WarningDataError('DUPLICATE_SOURCE', `data source already registered: ${adapter.source}`)
    }
    this.adapters.set(adapter.source, adapter)
    return () => {
      if (this.adapters.get(adapter.source) === adapter) this.adapters.delete(adapter.source)
    }
  }

  has(source: WarningDataSource): boolean {
    return this.adapters.has(source)
  }

  sources(): readonly string[] {
    return [...this.adapters.keys()].sort()
  }

  async execute<TData = unknown>(
    source: WarningDataSource,
    operation: string,
    input: unknown,
    context: WarningDataRequestContext,
    access: WarningDataAccess = 'read',
  ): Promise<WarningDataResult<TData>> {
    const queryTime = new Date(this.config.now?.() ?? Date.now()).toISOString()
    const adapter = this.adapters.get(source)
    const policy = this.config.sourcePolicies?.[source]
    const base = {
      schemaVersion: WARNING_DATA_SCHEMA_VERSION,
      taskId: context.taskId,
      traceId: context.traceId,
      source,
      operation,
      queryTime,
    } as const

    const fail = (code: string, message: string, retryable = false): WarningDataResult<TData> => ({
      ...base,
      status: 'FAILED',
      rowCount: 0,
      truncated: false,
      data: null,
      warnings: [],
      error: { code, message, retryable },
    })

    if (adapter === undefined) return fail('SOURCE_NOT_REGISTERED', `data source is not registered: ${source}`)
    if (access === 'write' && policy?.access !== 'read-write') return fail('WRITE_NOT_ALLOWED', `write access is disabled for ${source}`)
    if (policy?.allowedOperations !== undefined && !policy.allowedOperations.includes(operation)) {
      return fail('OPERATION_NOT_ALLOWED', `operation is not allowed: ${source}.${operation}`)
    }
    if (policy?.requireTenant === true && !context.tenantId) {
      return fail('TENANT_REQUIRED', `tenant context is required for ${source}`)
    }
    if (policy?.requiredGrant !== undefined && context.actionGrant?.[policy.requiredGrant] !== true) {
      return fail('ACTION_GRANT_REQUIRED', `action grant is required for ${source}`)
    }
    if (!adapter.operations.includes(operation)) return fail('OPERATION_NOT_REGISTERED', `adapter does not support operation: ${source}.${operation}`)

    const timeoutMs = policy?.timeoutMs ?? this.config.defaultTimeoutMs
    const maxRows = policy?.maxRows ?? this.config.defaultMaxRows
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maxRows) || maxRows <= 0) {
      return fail('INVALID_POLICY', `invalid policy for ${source}`)
    }

    const controller = new AbortController()
    const signal = combineSignals(context.signal, controller.signal)
    const timer = setTimeout(() => { controller.abort() }, timeoutMs)
    try {
      const response = await adapter.execute({
        source,
        operation,
        input,
        context: { ...context, signal },
        constraints: { timeoutMs, maxRows },
      })
      const normalized = normalizeResponse(response, maxRows)
      return {
        ...base,
        status: normalized.status,
        rowCount: normalized.rowCount,
        truncated: normalized.truncated,
        data: normalized.data as TData,
        warnings: normalized.warnings,
        ...(normalized.watermark === undefined ? {} : { watermark: normalized.watermark }),
      }
    } catch (error) {
      if (signal.aborted) return fail('TIMEOUT', `data source timed out: ${source}.${operation}`, true)
      if (error instanceof WarningDataError) return fail(error.code, error.message, error.retryable)
      return fail('ADAPTER_ERROR', `data source failed: ${source}.${operation}`, true)
    } finally {
      clearTimeout(timer)
    }
  }
}

interface NormalizedResponse {
  status: Exclude<WarningDataStatus, 'FAILED'>
  data: unknown
  rowCount: number
  truncated: boolean
  watermark?: string
  warnings: readonly string[]
}

function normalizeResponse(response: WarningDataAdapterResponse, maxRows: number): NormalizedResponse {
  const warnings = [...(response.warnings ?? [])]
  const sourceData = response.data
  const declaredRowCount = response.rowCount ?? (Array.isArray(sourceData) ? sourceData.length : 1)
  if (!Number.isInteger(declaredRowCount) || declaredRowCount < 0) {
    throw new WarningDataError('INVALID_RESULT', 'adapter returned an invalid rowCount')
  }
  if (Array.isArray(sourceData) && sourceData.length > maxRows) {
    warnings.push(`result truncated to ${String(maxRows)} rows`)
    const normalized: NormalizedResponse = {
      status: 'PARTIAL',
      data: sourceData.slice(0, maxRows),
      rowCount: maxRows,
      truncated: true,
      warnings,
    }
    if (response.watermark !== undefined) normalized.watermark = response.watermark
    return normalized
  }
  const normalized: NormalizedResponse = {
    status: response.status ?? 'SUCCESS',
    data: sourceData,
    rowCount: Math.min(declaredRowCount, maxRows),
    truncated: declaredRowCount > maxRows,
    warnings,
  }
  if (response.watermark !== undefined) normalized.watermark = response.watermark
  return normalized
}

function combineSignals(parent: AbortSignal | undefined, timeout: AbortSignal): AbortSignal {
  if (parent === undefined) return timeout
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([parent, timeout])
  const controller = new AbortController()
  const abort = (): void => { controller.abort() }
  if (parent.aborted || timeout.aborted) controller.abort()
  else {
    parent.addEventListener('abort', abort, { once: true })
    timeout.addEventListener('abort', abort, { once: true })
  }
  return controller.signal
}
