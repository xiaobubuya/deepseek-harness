# `@deepseek-ai/dsh-warning-data-core`

Shared data-access boundary for the warning center. The package contains no database driver and no CLI. LPS, Doris, NTSDB, and POPO integrations implement the `WarningDataAdapter` contract and register with `WarningDataCore`.

The core owns the cross-source contract:

- task, tenant, actor, trace, deadline, and action-grant context;
- source and operation allow-lists;
- read-only by default, explicit read/write policy checks, and tenant requirements;
- timeout and cancellation propagation;
- maximum result size and truncation reporting;
- a stable `v1` result envelope and safe error normalization.
- cross-source completeness assessment for missing, failed, partial, or stale-input signals.

Harness plugins should call `WarningDataCore.execute()` directly. They must not spawn a shell process or parse CLI output. Transport details stay inside each adapter, so the same implementation can later be used by an internal service or a test double.

Example adapter:

```ts
const doris: WarningDataAdapter = {
  source: 'doris',
  operations: ['detail.query'],
  async execute({ input, context, constraints }) {
    return { data: await queryDoris(input, { signal: context.signal, limit: constraints.maxRows }) }
  },
}
const core = new WarningDataCore({ sourcePolicies: { doris: { requireTenant: true } } })
core.register(doris)
```

POPO write operations should use a separate policy with `requiredGrant: 'popoTeam'` and should remain disabled until approval, idempotency, and audit handling are implemented.
