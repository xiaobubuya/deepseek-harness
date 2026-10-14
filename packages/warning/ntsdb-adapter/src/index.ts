/** Controlled HTTP adapter for InfluxDB-compatible NTSDB query endpoints. */

import {
  WarningDataError,
  type WarningDataAdapter,
  type WarningDataAdapterRequest,
  type WarningDataAdapterResponse,
} from '@deepseek-ai/dsh-warning-data-core'

export const NTSDB_OPERATIONS = ['query'] as const
export type NtsdbOperation = typeof NTSDB_OPERATIONS[number]
export type NtsdbDatasource = string

export interface NtsdbQueryInput {
  readonly datasource: NtsdbDatasource
  readonly database: string
  readonly query: string
}

export interface NtsdbAdapterConfig {
  /** Map a logical datasource (for example console or outer) to its /query base URL. */
  readonly endpoints: Readonly<Record<string, string>>
  readonly maxQueryLength?: number
  readonly maxWindowMs?: number
  readonly fetch?: typeof globalThis.fetch
}

interface InfluxSeries {
  readonly name?: string
  readonly columns?: readonly string[]
  readonly values?: readonly unknown[][]
  readonly tags?: Readonly<Record<string, string>>
}

interface InfluxResult {
  readonly error?: string
  readonly series?: readonly InfluxSeries[]
}

interface InfluxResponse {
  readonly results?: readonly InfluxResult[]
  readonly error?: string
}

const DEFAULT_MAX_QUERY_LENGTH = 8_000
const DEFAULT_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000
const COMMENT_PATTERN = /(?:--|\/\*|\*\/|#[^\n]*)/u
const MUTATION_PATTERN = /\b(?:insert|select\s+into|delete|drop|alter|create|grant|revoke|show\s+queries|kill\s+query)\b/iu
const TIME_PREDICATE = /\btime\b\s*(?:>=|>|between|=)/iu
const RELATIVE_WINDOW = /now\(\)\s*-\s*(\d+)\s*(ms|s|m|h|d|w)\b/iu

export class NtsdbAdapter implements WarningDataAdapter<NtsdbQueryInput> {
  readonly source = 'ntsdb' as const
  readonly operations = NTSDB_OPERATIONS
  private readonly endpoints: Readonly<Record<string, string>>
  private readonly maxQueryLength: number
  private readonly maxWindowMs: number
  private readonly request: typeof globalThis.fetch

  constructor(config: NtsdbAdapterConfig) {
    if (Object.keys(config.endpoints).length === 0) throw new WarningDataError('INVALID_CONFIG', 'NTSDB endpoints are required')
    this.endpoints = Object.fromEntries(Object.entries(config.endpoints).map(([name, endpoint]) => [name, normalizeEndpoint(endpoint)]))
    this.maxQueryLength = config.maxQueryLength ?? DEFAULT_MAX_QUERY_LENGTH
    this.maxWindowMs = config.maxWindowMs ?? DEFAULT_MAX_WINDOW_MS
    this.request = config.fetch ?? globalThis.fetch
    if (!Number.isInteger(this.maxQueryLength) || this.maxQueryLength <= 0) throw new WarningDataError('INVALID_CONFIG', 'NTSDB maxQueryLength must be positive')
    if (!Number.isInteger(this.maxWindowMs) || this.maxWindowMs <= 0) throw new WarningDataError('INVALID_CONFIG', 'NTSDB maxWindowMs must be positive')
    if (typeof this.request !== 'function') throw new WarningDataError('INVALID_CONFIG', 'fetch implementation is required')
  }

  async execute(request: WarningDataAdapterRequest<NtsdbQueryInput>): Promise<WarningDataAdapterResponse> {
    if (request.operation !== 'query') throw new WarningDataError('OPERATION_NOT_REGISTERED', `unsupported NTSDB operation: ${request.operation}`)
    const input = queryInput(request.input)
    validateQuery(input.query, this.maxQueryLength, this.maxWindowMs)
    const endpoint = this.endpoints[input.datasource]
    if (endpoint === undefined) throw new WarningDataError('INVALID_INPUT', `unsupported NTSDB datasource: ${input.datasource}`)
    const url = new URL(`${endpoint}/query`)
    url.searchParams.set('db', input.database)
    url.searchParams.set('q', input.query)
    const payload = await this.send(url, request)
    const result = payload.results?.[0]
    if (payload.error !== undefined || result?.error !== undefined) {
      throw new WarningDataError('UPSTREAM_QUERY_ERROR', payload.error ?? result?.error ?? 'NTSDB query failed', false)
    }
    const rows = flattenSeries(result?.series ?? [])
    const limited = rows.slice(0, request.constraints.maxRows)
    const truncated = rows.length > limited.length
    const watermark = latestTimestamp(limited)
    return {
      status: truncated ? 'PARTIAL' : 'SUCCESS',
      data: limited,
      rowCount: rows.length,
      ...(watermark === undefined ? {} : { watermark }),
      ...(truncated ? { warnings: [`NTSDB result truncated to ${String(request.constraints.maxRows)} rows`] } : {}),
    }
  }

  private async send(url: URL, request: WarningDataAdapterRequest): Promise<InfluxResponse> {
    const headers = new Headers({ accept: 'application/json' })
    headers.set('X-Request-Id', request.context.metadata?.requestId ?? request.context.traceId)
    headers.set('X-Agent-Task-Id', request.context.taskId)
    let response: Response
    try {
      response = await this.request(url, {
        method: 'GET',
        headers,
        ...(request.context.signal === undefined ? {} : { signal: request.context.signal }),
      })
    } catch (error) {
      if (request.context.signal?.aborted) throw error
      throw new WarningDataError('UPSTREAM_NETWORK_ERROR', 'NTSDB query request failed', true)
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new WarningDataError('INVALID_RESPONSE', 'NTSDB returned invalid JSON')
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new WarningDataError('INVALID_RESPONSE', 'NTSDB response must be an object')
    if (!response.ok) throw new WarningDataError(`UPSTREAM_HTTP_${String(response.status)}`, `NTSDB returned HTTP ${String(response.status)}`, response.status === 429 || response.status >= 500)
    return body
  }
}

function queryInput(value: unknown): NtsdbQueryInput {
  const object = objectValue(value, 'NTSDB query input')
  if (typeof object.datasource !== 'string' || object.datasource.trim() === '') throw new WarningDataError('INVALID_INPUT', 'NTSDB datasource is required')
  if (typeof object.database !== 'string' || object.database.trim() === '') throw new WarningDataError('INVALID_INPUT', 'NTSDB database is required')
  if (typeof object.query !== 'string' || object.query.trim() === '') throw new WarningDataError('INVALID_INPUT', 'NTSDB query is required')
  return { datasource: object.datasource, database: object.database, query: object.query }
}

function validateQuery(query: string, maxLength: number, maxWindowMs: number): void {
  const normalized = query.trim()
  if (normalized.length > maxLength) throw new WarningDataError('INVALID_QUERY', `NTSDB query exceeds ${String(maxLength)} characters`)
  if (!/^select\b/iu.test(normalized)) throw new WarningDataError('INVALID_QUERY', 'NTSDB query must be a SELECT statement')
  if (normalized.includes(';') || COMMENT_PATTERN.test(normalized)) throw new WarningDataError('INVALID_QUERY', 'NTSDB query must be a single statement without comments')
  if (MUTATION_PATTERN.test(normalized)) throw new WarningDataError('INVALID_QUERY', 'NTSDB query contains a forbidden operation')
  if (!TIME_PREDICATE.test(normalized)) throw new WarningDataError('INVALID_QUERY', 'NTSDB query must contain a bounded time predicate')
  const relative = normalized.match(RELATIVE_WINDOW)
  if (relative !== null) {
    const amount = Number(relative[1])
    const unit = relative[2]
    if (unit === undefined) return
    const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit]
    if (multiplier !== undefined && amount * multiplier > maxWindowMs) throw new WarningDataError('INVALID_QUERY', 'NTSDB query time window is too large')
  }
}

function flattenSeries(series: readonly InfluxSeries[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (const item of series) {
    const columns = item.columns ?? []
    for (const values of item.values ?? []) {
      const row: Record<string, unknown> = { ...(item.tags ?? {}) }
      columns.forEach((column, index) => { row[column] = values[index] })
      if (item.name !== undefined) row._measurement = item.name
      rows.push(row)
    }
  }
  return rows
}

function latestTimestamp(rows: readonly Record<string, unknown>[]): string | undefined {
  const times = rows.map(row => row.time).filter((value): value is string => typeof value === 'string')
  if (times.length === 0) return undefined
  return times.sort().at(-1)
}

function normalizeEndpoint(value: string): string {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new WarningDataError('INVALID_CONFIG', 'NTSDB endpoint must be a valid URL') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new WarningDataError('INVALID_CONFIG', 'NTSDB endpoint must use HTTP or HTTPS')
  if (parsed.username !== '' || parsed.password !== '') throw new WarningDataError('INVALID_CONFIG', 'NTSDB endpoint must not contain credentials')
  return value.replace(/\/+$/u, '')
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WarningDataError('INVALID_INPUT', `${label} must be an object`)
  return value as Record<string, unknown>
}
