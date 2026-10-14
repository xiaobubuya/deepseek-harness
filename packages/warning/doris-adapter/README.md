# `@deepseek-ai/dsh-warning-doris-adapter`

Controlled Doris adapter for the warning center. It calls the existing `vcloud-lps-admin-server` APIs and never connects to Doris directly:

- `query` -> `POST /doris-skill/execute`;
- `tables` -> `GET /doris-skill/tables`;
- `tableSchema` -> `GET /doris-skill/tables/{tableName}`.

The adapter sends the Agent API key, task ID, and request ID as headers. SQL is restricted to a single `SELECT` statement; CTEs, comments, and mutations are rejected, and a bounded predicate on a configured time column is required. The adapter does not maintain a local table allowlist; table discovery uses the `tables`/`tableSchema` endpoints. The admin server remains the authority for authentication, database/table permissions, SQL validation, rate limits, concurrency, timeout, and response-size protection.

Register it with `WarningDataCore` and call it through the normal structured adapter boundary. Do not pass database credentials to Harness or allow the model to construct unrestricted SQL.
