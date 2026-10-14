# LPS adapter

`@deepseek-ai/dsh-warning-lps-adapter` exposes the read-only LPS admin APIs through the shared `warning-data-core` contract.

```ts
const adapter = new LpsAdapter({
  baseUrl: process.env.LPS_ADMIN_BASE_URL!,
  apiKey: process.env.LPS_API_KEY,
})

core.register(adapter)
await core.execute('lps', 'processes', { query: { status: 1 } }, context)
```

Supported operations are `processes`, `metrics`, `datasets`, `datasources`, `alerts`, and configurable `lineage`. The adapter calls the existing admin-server REST endpoints and propagates `X-Request-Id` and `X-Agent-Task-Id`. It never connects to the LPS configuration database directly.

The default lineage path is `/lps-agent/v1/lineage`; configure `paths.lineage` when the deployed service exposes a different path. The adapter accepts both raw endpoint payloads and the deployed `{ code, data, requestId }` response envelope.
