/** Controlled HTTP adapter for the vcloud-lps Doris read APIs. */

import {
  WarningDataError,
  type WarningDataAdapter,
  type WarningDataAdapterRequest,
  type WarningDataAdapterResponse,
} from '@deepseek-ai/dsh-warning-data-core'

export const DORIS_OPERATIONS = ['query', 'tables', 'tableSchema'] as const
export type DorisOperation = typeof DORIS_OPERATIONS[number]

export interface DorisQueryInput {
  readonly sql: string
  readonly dbName?: string
}

export interface DorisTablesInput {
  readonly dbName?: string
}

export interface DorisTableSchemaInput {
  readonly tableName: string
}

export type DorisAdapterInput = DorisQueryInput | DorisTablesInput | DorisTableSchemaInput

export interface DorisAdapterConfig {
  readonly baseUrl: string
  readonly apiKey: string
  readonly defaultDatabase?: string
  readonly requiredTimeColumns?: readonly string[]
  readonly fetch?: typeof globalThis.fetch
}

interface DorisApiResponse {
  readonly code?: number
  readonly data?: unknown
  readonly requestId?: string
}

interface DorisQueryPayload {
  readonly data?: unknown[]
  readonly rowCount?: number
  readonly truncated?: boolean
  readonly execTimeMs?: number
}

const DEFAULT_DATABASE = 'lps_doris_bucket'
const DEFAULT_TIME_COLUMNS = ['event_time', 'lps_event_time', 'partitionTime', 'time']
const SQL_COMMENT_PATTERN = /(?:--|\/\*|\*\/|#[^\n]*)/u
const SQL_MUTATION_PATTERN = /\b(?:insert|update|delete|drop|alter|create|truncate|grant|revoke|call|outfile|load)\b/iu

/**
 * Doris adapter that only talks to the existing protected admin-server API.
 * Database credentials never enter this process.
 */
export class DorisAdapter implements WarningDataAdapter {
  readonly source = 'doris' as const
  readonly operations = DORIS_OPERATIONS
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly defaultDatabase: string
  private readonly requiredTimeColumns: readonly string[]
  private readonly request: typeof globalThis.fetch

  constructor(config: DorisAdapterConfig) {
    const parsed = new URL(config.baseUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new WarningDataError('INVALID_CONFIG', 'Doris baseUrl must use HTTP or HTTPS')
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new WarningDataError('INVALID_CONFIG', 'Doris baseUrl must not contain credentials')
    }
    if (config.apiKey.trim() === '') throw new WarningDataError('INVALID_CONFIG', 'Doris apiKey is required')
    this.baseUrl = config.baseUrl.replace(/\/+$/u, '')
    this.apiKey = config.apiKey
    this.defaultDatabase = config.defaultDatabase ?? DEFAULT_DATABASE
    this.requiredTimeColumns = config.requiredTimeColumns ?? DEFAULT_TIME_COLUMNS
    this.request = config.fetch ?? globalThis.fetch
    if (typeof this.request !== 'function') throw new WarningDataError('INVALID_CONFIG', 'fetch implementation is required')
  }

  async execute(request: WarningDataAdapterRequest): Promise<WarningDataAdapterResponse> {
    switch (request.operation as DorisOperation) {
      case 'query': return this.query(request)
      case 'tables': return this.tables(request)
      case 'tableSchema': return this.tableSchema(request)
      default: throw new WarningDataError('OPERATION_NOT_REGISTERED', `unsupported Doris operation: ${request.operation}`)
    }
  }

  private async query(request: WarningDataAdapterRequest): Promise<WarningDataAdapterResponse> {
    const input = queryInput(request.input)
    validateReadOnlySql(input.sql, this.requiredTimeColumns)
    const payload = await this.post('/doris-skill/execute', {
      dbName: input.dbName ?? this.defaultDatabase,
      sql: input.sql,
    }, request)
    const result = objectValue(payload.data, 'Doris query data') as DorisQueryPayload
    const rows = Array.isArray(result.data) ? result.data : []
    const rowCount = integerValue(result.rowCount, rows.length, 'Doris query rowCount')
    const warnings = result.truncated === true ? ['upstream Doris result was truncated'] : []
    if (result.execTimeMs !== undefined) warnings.push(`Doris query execution time: ${String(result.execTimeMs)}ms`)
    return {
      status: result.truncated === true ? 'PARTIAL' : 'SUCCESS',
      data: rows,
      rowCount,
      warnings,
    }
  }

  private async tables(request: WarningDataAdapterRequest): Promise<WarningDataAdapterResponse> {
    const input = optionalDatabaseInput(request.input)
    const suffix = input.dbName === undefined ? '' : `?dbName=${encodeURIComponent(input.dbName)}`
    const payload = await this.get(`/doris-skill/tables${suffix}`, request)
    return { data: payload.data ?? [] }
  }

  private async tableSchema(request: WarningDataAdapterRequest): Promise<WarningDataAdapterResponse> {
    const input = tableSchemaInput(request.input)
    const payload = await this.get(`/doris-skill/tables/${encodeURIComponent(input.tableName)}`, request)
    return { data: payload.data ?? {} }
  }

  private async get(path: string, request: WarningDataAdapterRequest): Promise<DorisApiResponse> {
    return this.send(path, {
      method: 'GET',
      ...(request.context.signal === undefined ? {} : { signal: request.context.signal }),
    }, request)
  }

  private async post(path: string, body: object, request: WarningDataAdapterRequest): Promise<DorisApiResponse> {
    return this.send(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(request.context.signal === undefined ? {} : { signal: request.context.signal }),
    }, request)
  }

  private async send(path: string, init: RequestInit, request: WarningDataAdapterRequest): Promise<DorisApiResponse> {
    const headers = new Headers(init.headers)
    headers.set('X-Api-Key', this.apiKey)
    headers.set('X-Request-Id', request.context.metadata?.requestId ?? request.context.traceId)
    headers.set('X-Agent-Task-Id', request.context.taskId)
    let response: Response
    try {
      response = await this.request(`${this.baseUrl}${path}`, { ...init, headers })
    } catch (error) {
      if (request.context.signal?.aborted) throw error
      throw new WarningDataError('UPSTREAM_NETWORK_ERROR', 'Doris admin API request failed', true)
    }
    const body = await parseJson(response)
    const apiCode = typeof body.code === 'number' ? body.code : response.status
    if (!response.ok || apiCode < 200 || apiCode >= 300) {
      throw new WarningDataError(`UPSTREAM_HTTP_${String(apiCode)}`, `Doris admin API returned HTTP ${String(apiCode)}`, apiCode === 429 || apiCode >= 500)
    }
    return body
  }
}

function queryInput(value: unknown): DorisQueryInput {
  const object = objectValue(value, 'Doris query input')
  if (typeof object.sql !== 'string' || object.sql.trim() === '') throw new WarningDataError('INVALID_INPUT', 'Doris query requires sql')
  return { sql: object.sql, ...(typeof object.dbName === 'string' ? { dbName: object.dbName } : {}) }
}

function optionalDatabaseInput(value: unknown): DorisTablesInput {
  if (value === undefined || value === null) return {}
  const object = objectValue(value, 'Doris tables input')
  if (object.dbName !== undefined && typeof object.dbName !== 'string') throw new WarningDataError('INVALID_INPUT', 'Doris dbName must be a string')
  return typeof object.dbName === 'string' ? { dbName: object.dbName } : {}
}

function tableSchemaInput(value: unknown): DorisTableSchemaInput {
  const object = objectValue(value, 'Doris table schema input')
  if (typeof object.tableName !== 'string' || !/^[A-Za-z0-9_]+$/u.test(object.tableName)) {
    throw new WarningDataError('INVALID_INPUT', 'Doris tableName must contain only letters, numbers, and underscores')
  }
  return { tableName: object.tableName }
}

function validateReadOnlySql(sql: string, requiredTimeColumns: readonly string[]): void {
  const normalized = sql.trim()
  if (!/^select\b/iu.test(normalized)) throw new WarningDataError('INVALID_SQL', 'Doris query must be a SELECT statement')
  if (normalized.includes(';') || SQL_COMMENT_PATTERN.test(normalized)) throw new WarningDataError('INVALID_SQL', 'Doris query must be a single statement without comments')
  if (SQL_MUTATION_PATTERN.test(normalized)) throw new WarningDataError('INVALID_SQL', 'Doris query contains a forbidden operation')
  if (requiredTimeColumns.length > 0 && !requiredTimeColumns.some(column => new RegExp(`\\b${escapeRegExp(column)}\\b\\s*(?:>=|>|between|=)`, 'iu').test(normalized))) {
    throw new WarningDataError('INVALID_SQL', 'Doris query must contain a bounded time predicate')
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WarningDataError('INVALID_INPUT', `${label} must be an object`)
  return value as Record<string, unknown>
}

function integerValue(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < 0) throw new WarningDataError('INVALID_RESPONSE', `${label} is invalid`)
  return value as number
}

async function parseJson(response: Response): Promise<DorisApiResponse> {
  let value: unknown
  try {
    value = await response.json()
  } catch {
    throw new WarningDataError('INVALID_RESPONSE', 'Doris admin API returned invalid JSON', response.status >= 500)
  }
  return objectValue(value, 'Doris admin API response')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
