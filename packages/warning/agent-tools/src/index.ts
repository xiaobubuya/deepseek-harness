/** First-party, read-only Harness tools for warning investigations. */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ParameterSchemaSpec, type ToolDefinition, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  WarningDataCore,
  type WarningDataRequestContext,
} from '@deepseek-ai/dsh-warning-data-core'
import { DorisAdapter } from '@deepseek-ai/dsh-warning-doris-adapter'
import { LpsAdapter } from '@deepseek-ai/dsh-warning-lps-adapter'
import { NtsdbAdapter } from '@deepseek-ai/dsh-warning-ntsdb-adapter'

export const WARNING_AGENT_TOOL_NAMES = [
  'lps_get_processes',
  'lps_get_metrics',
  'lps_get_datasets',
  'lps_get_datasources',
  'lps_get_alerts',
  'lps_get_lineage',
  'doris_list_tables',
  'doris_get_table_schema',
  'doris_query',
  'ntsdb_query',
] as const

export type WarningAgentToolName = typeof WARNING_AGENT_TOOL_NAMES[number]

export interface WarningAgentToolConfig {
  readonly core: WarningDataCore
  readonly requestContext: Omit<WarningDataRequestContext, 'signal'>
}

export interface WarningDataEnvironment {
  readonly WARNING_LPS_BASE_URL?: string
  readonly WARNING_LPS_API_KEY?: string
  readonly WARNING_DORIS_BASE_URL?: string
  readonly WARNING_DORIS_API_KEY?: string
  readonly WARNING_DORIS_DATABASE?: string
  readonly WARNING_NTSDB_ENDPOINTS_JSON?: string
  readonly WARNING_DATA_REQUIRE_TENANT?: string
}

const resultSchema = {
  type: 'object' as const,
  additionalProperties: true,
  properties: {
    schemaVersion: { type: 'string' as const, required: true as const },
    taskId: { type: 'string' as const, required: true as const },
    traceId: { type: 'string' as const, required: true as const },
    source: { type: 'string' as const, required: true as const },
    operation: { type: 'string' as const, required: true as const },
    queryTime: { type: 'string' as const, required: true as const },
    status: { type: 'string' as const, required: true as const },
    rowCount: { type: 'integer' as const, required: true as const },
    truncated: { type: 'boolean' as const, required: true as const },
    data: { type: 'json' as const },
    watermark: { type: 'string' as const },
    warnings: { type: 'array' as const, required: true, items: { type: 'string' as const } },
    error: { type: 'json' as const },
  },
} as const satisfies ValueSchemaSpec

const idSchema = { oneOf: [{ type: 'string' as const }, { type: 'number' as const }] as const }

type WarningAgentToolValue = Record<string, JsonValue> & {
  schemaVersion: string
  taskId: string
  traceId: string
  source: string
  operation: string
  queryTime: string
  status: string
  rowCount: number
  truncated: boolean
  data: JsonValue
  warnings: string[]
}

function renderResult(_args: unknown, value: unknown): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function collectionParameters(description: string): ParameterSchemaSpec {
  return {
    query: {
      type: 'object' as const,
      additionalProperties: true,
      description,
    },
  }
}

function dataTool(
  name: WarningAgentToolName,
  description: string,
  source: 'lps' | 'doris' | 'ntsdb',
  operation: string,
  parameters: ParameterSchemaSpec,
  config: WarningAgentToolConfig,
): ToolDefinition {
  return defineTool({
    name,
    description,
    parameters,
    output: { schema: resultSchema, render: renderResult },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const result = await config.core.execute(source, operation, args, { ...config.requestContext, signal: exec.signal })
      return JSON.parse(JSON.stringify(result)) as WarningAgentToolValue
    },
  })
}

export function createWarningAgentTools(config: WarningAgentToolConfig): ReadonlyMap<WarningAgentToolName, ToolDefinition> {
  const tools = [
    dataTool('lps_get_processes', 'Read LPS process definitions and status.', 'lps', 'processes', collectionParameters('Optional scalar filters for the LPS process endpoint.'), config),
    dataTool('lps_get_metrics', 'Read LPS metric definitions.', 'lps', 'metrics', collectionParameters('Optional scalar filters for the LPS metric endpoint.'), config),
    dataTool('lps_get_datasets', 'Read LPS dataset definitions.', 'lps', 'datasets', collectionParameters('Optional scalar filters for the LPS dataset endpoint.'), config),
    dataTool('lps_get_datasources', 'Read LPS datasource definitions.', 'lps', 'datasources', collectionParameters('Optional scalar filters for the LPS datasource endpoint.'), config),
    dataTool('lps_get_alerts', 'Read LPS alert definitions.', 'lps', 'alerts', collectionParameters('Optional scalar filters for the LPS alert endpoint.'), config),
    dataTool('lps_get_lineage', 'Read LPS process or metric lineage.', 'lps', 'lineage', {
      processId: { ...idSchema, description: 'Optional LPS process id.' },
      metricId: { ...idSchema, description: 'Optional LPS metric id.' },
    }, config),
    dataTool('doris_list_tables', 'List tables exposed by the protected Doris read API.', 'doris', 'tables', {
      dbName: { type: 'string' as const, description: 'Optional database name.' },
    }, config),
    dataTool('doris_get_table_schema', 'Read one Doris table schema through the protected read API.', 'doris', 'tableSchema', {
      tableName: { type: 'string' as const, required: true, description: 'Table name.' },
    }, config),
    dataTool('doris_query', 'Run a bounded, read-only Doris SELECT query.', 'doris', 'query', {
      sql: { type: 'string' as const, required: true, description: 'One bounded SELECT statement.' },
      dbName: { type: 'string' as const, description: 'Optional database name.' },
    }, config),
    dataTool('ntsdb_query', 'Run a bounded, read-only NTSDB/InfluxQL query.', 'ntsdb', 'query', {
      datasource: { type: 'string' as const, required: true, description: 'Configured logical NTSDB datasource.' },
      database: { type: 'string' as const, required: true, description: 'NTSDB database.' },
      query: { type: 'string' as const, required: true, description: 'One bounded SELECT query.' },
    }, config),
  ]
  return new Map(tools.map(tool => [tool.name as WarningAgentToolName, tool]))
}

/** Register only the allow-listed tools in an Agent Scope. */
export function registerWarningAgentTools(
  agentCtx: Context,
  config: WarningAgentToolConfig,
  allowedTools: readonly string[],
): () => void {
  const known = createWarningAgentTools(config)
  const requested = [...new Set(allowedTools)]
  const unknown = requested.filter(name => !known.has(name as WarningAgentToolName))
  if (unknown.length > 0) throw new Error(`UNKNOWN_TOOL: ${unknown.join(', ')}`)
  const disposers = requested.map((name) => {
    const definition = known.get(name as WarningAgentToolName)
    if (definition === undefined) throw new Error(`UNKNOWN_TOOL: ${name}`)
    return agentCtx.tools.register(definition)
  })
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

/** Build the default core from deployment environment; credentials stay out of source and prompts. */
export function createWarningDataCoreFromEnvironment(env: WarningDataEnvironment = process.env): WarningDataCore {
  const requireTenant = env.WARNING_DATA_REQUIRE_TENANT !== 'false'
  const core = new WarningDataCore({
    sourcePolicies: {
      lps: { requireTenant },
      doris: { requireTenant },
      ntsdb: { requireTenant },
    },
  })
  const lpsBaseUrl = env.WARNING_LPS_BASE_URL?.trim()
  if (lpsBaseUrl !== undefined && lpsBaseUrl !== '') {
    core.register(new LpsAdapter({
      baseUrl: lpsBaseUrl,
      ...(env.WARNING_LPS_API_KEY === undefined || env.WARNING_LPS_API_KEY.trim() === '' ? {} : { apiKey: env.WARNING_LPS_API_KEY }),
    }))
  }
  const dorisBaseUrl = env.WARNING_DORIS_BASE_URL?.trim()
  const dorisApiKey = env.WARNING_DORIS_API_KEY?.trim()
  if (dorisBaseUrl !== undefined && dorisBaseUrl !== '' && dorisApiKey !== undefined && dorisApiKey !== '') {
    core.register(new DorisAdapter({
      baseUrl: dorisBaseUrl,
      apiKey: dorisApiKey,
      ...(env.WARNING_DORIS_DATABASE === undefined ? {} : { defaultDatabase: env.WARNING_DORIS_DATABASE }),
    }))
  }
  const ntsdbEndpoints = env.WARNING_NTSDB_ENDPOINTS_JSON?.trim()
  if (ntsdbEndpoints !== undefined && ntsdbEndpoints !== '') {
    let endpoints: unknown
    try { endpoints = JSON.parse(ntsdbEndpoints) } catch { throw new Error('WARNING_NTSDB_ENDPOINTS_JSON must be valid JSON') }
    if (typeof endpoints !== 'object' || endpoints === null || Array.isArray(endpoints)) throw new Error('WARNING_NTSDB_ENDPOINTS_JSON must be an object')
    core.register(new NtsdbAdapter({ endpoints: endpoints as Record<string, string> }))
  }
  return core
}
