# Warning Agent Tools

This package registers the read-only LPS, Doris, and NTSDB tools used by the
warning-agent Harness Runtime. It deliberately keeps model-facing schemas and
task authorization separate from the transport adapters.

`registerWarningAgentTools()` installs only the names present in a delivery's
`allowedTools` list into the current Agent Scope. Each tool executes through
`WarningDataCore`, so source policy, row limits, timeout, tenant context, and
cancellation remain centralized.

The default Runtime core reads deployment-only settings from environment
variables. Credentials are never included in prompts or task payloads:

- `WARNING_LPS_BASE_URL`, optional `WARNING_LPS_API_KEY`
- `WARNING_DORIS_BASE_URL`, `WARNING_DORIS_API_KEY`, optional `WARNING_DORIS_DATABASE`
- `WARNING_NTSDB_ENDPOINTS_JSON` (logical datasource to `/query` URL map)
- `WARNING_DATA_REQUIRE_TENANT` (defaults to `true`)
