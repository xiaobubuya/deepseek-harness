/** Read-only adapter for the vcloud-lps admin-server REST APIs. */

import {
  WarningDataError,
  type WarningDataAdapter,
  type WarningDataAdapterRequest,
  type WarningDataAdapterResponse,
} from '@deepseek-ai/dsh-warning-data-core'

export const LPS_OPERATIONS = ['lineage', 'processes', 'metrics', 'datasets', 'datasources', 'alerts'] as const
export type LpsOperation = typeof LPS_OPERATIONS[number]

export interface LpsLineageInput {
  readonly processId?: string | number
  readonly metricId?: string | number
}

export interface LpsCollectionInput {
  readonly query?: Readonly<Record<string, string | number | boolean | null | undefined>>
}

export type LpsAdapterInput = LpsLineageInput | LpsCollectionInput | undefined

export interface LpsAdapterConfig {
  readonly baseUrl: string
  readonly apiKey?: string
  readonly paths?: Partial<Record<LpsOperation, string>>
  readonly fetch?: typeof globalThis.fetch
}

const DEFAULT_PATHS: Record<LpsOperation, string> = {
  lineage: '/lps-agent/v1/lineage',
  processes: '/process/queryAll',
  metrics: '/metric/queryAll',
  datasets: '/dataset/queryAll',
  datasources: '/datasource/queryAll',
  alerts: '/alert/queryAll',
}

interface LpsApiBody {
  readonly code?: number
  readonly data?: unknown
  readonly message?: string
  readonly requestId?: string
  readonly [key: string]: unknown
}

export class LpsAdapter implements WarningDataAdapter<LpsAdapterInput> {
  readonly source = 'lps' as const
  readonly operations = LPS_OPERATIONS
  private readonly baseUrl: string
  private readonly apiKey: string | undefined
  private readonly paths: Record<LpsOperation, string>
  private readonly request: typeof globalThis.fetch

  constructor(config: LpsAdapterConfig) {
    const parsed = new URL(config.baseUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new WarningDataError('INVALID_CONFIG', 'LPS baseUrl must use HTTP or HTTPS')
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new WarningDataError('INVALID_CONFIG', 'LPS baseUrl must not contain credentials')
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/u, '')
    const apiKey = config.apiKey?.trim()
    this.apiKey = apiKey === undefined || apiKey === '' ? undefined : apiKey
    this.paths = { ...DEFAULT_PATHS, ...config.paths }
    this.request = config.fetch ?? globalThis.fetch
    if (typeof this.request !== 'function') throw new WarningDataError('INVALID_CONFIG', 'fetch implementation is required')
  }

  async execute(request: WarningDataAdapterRequest<LpsAdapterInput>): Promise<WarningDataAdapterResponse> {
    const operation = operationValue(request.operation)
    const input = request.input ?? {}
    const path = this.paths[operation]
    const url = new URL(`${this.baseUrl}${path}`)
    if (operation === 'lineage') {
      const lineage = lineageInput(input)
      if (lineage.processId !== undefined) url.searchParams.set('processId', String(lineage.processId))
      if (lineage.metricId !== undefined) url.searchParams.set('metricId', String(lineage.metricId))
      if (lineage.processId === undefined && lineage.metricId === undefined) {
        throw new WarningDataError('INVALID_INPUT', 'LPS lineage requires processId or metricId')
      }
    } else {
      const query = collectionInput(input).query
      for (const [key, value] of Object.entries(query ?? {})) {
        if (!/^[A-Za-z][A-Za-z0-9_.-]*$/u.test(key)) throw new WarningDataError('INVALID_INPUT', `invalid LPS query parameter: ${key}`)
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
      }
    }
    const body = await this.send(url, request)
    const data = body.data === undefined ? body : body.data
    return Array.isArray(data) ? { data, rowCount: data.length } : { data }
  }

  private async send(url: URL, request: WarningDataAdapterRequest): Promise<LpsApiBody> {
    const headers = new Headers({ accept: 'application/json' })
    if (this.apiKey !== undefined) headers.set('X-Api-Key', this.apiKey)
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
      throw new WarningDataError('UPSTREAM_NETWORK_ERROR', 'LPS admin API request failed', true)
    }
    const body = await parseJson(response)
    const code = typeof body.code === 'number' ? body.code : response.status
    if (!response.ok || (body.code !== undefined && (code < 200 || code >= 300))) {
      throw new WarningDataError(`UPSTREAM_HTTP_${String(code)}`, `LPS admin API returned HTTP ${String(code)}`, code === 429 || code >= 500)
    }
    return body
  }
}

function operationValue(value: string): LpsOperation {
  if ((LPS_OPERATIONS as readonly string[]).includes(value)) return value as LpsOperation
  throw new WarningDataError('OPERATION_NOT_REGISTERED', `unsupported LPS operation: ${value}`)
}

function lineageInput(value: unknown): LpsLineageInput {
  const object = objectValue(value, 'LPS lineage input')
  const processId = idValue(object.processId, 'processId')
  const metricId = idValue(object.metricId, 'metricId')
  return { ...(processId === undefined ? {} : { processId }), ...(metricId === undefined ? {} : { metricId }) }
}

function collectionInput(value: unknown): LpsCollectionInput {
  if (value === undefined || value === null) return {}
  const object = objectValue(value, 'LPS input')
  if (object.query === undefined) return {}
  const query = objectValue(object.query, 'LPS query')
  for (const [key, value] of Object.entries(query)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/u.test(key)) throw new WarningDataError('INVALID_INPUT', `invalid LPS query parameter: ${key}`)
    if (value !== undefined && value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new WarningDataError('INVALID_INPUT', `LPS query parameter must be scalar: ${key}`)
    }
  }
  return { query: query as Readonly<Record<string, string | number | boolean | null | undefined>> }
}

function idValue(value: unknown, name: string): string | number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'number' && !Number.isSafeInteger(value))) {
    throw new WarningDataError('INVALID_INPUT', `LPS ${name} must be a string or safe integer`)
  }
  return value
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WarningDataError('INVALID_INPUT', `${label} must be an object`)
  return value as Record<string, unknown>
}

async function parseJson(response: Response): Promise<LpsApiBody> {
  let value: unknown
  try {
    value = await response.json()
  } catch {
    throw new WarningDataError('INVALID_RESPONSE', 'LPS admin API returned invalid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { data: value }
  }
  return value as LpsApiBody
}
