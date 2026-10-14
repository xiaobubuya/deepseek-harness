# NTSDB adapter

`@deepseek-ai/dsh-warning-ntsdb-adapter` provides a controlled InfluxDB-compatible `/query` transport for NTSDB.

```ts
const adapter = new NtsdbAdapter({
  endpoints: {
    console: process.env.NTSDB_CONSOLE_URL!,
    outer: process.env.NTSDB_OUTER_URL!,
  },
})

core.register(adapter)
await core.execute('ntsdb', 'query', {
  datasource: 'console',
  database: 'vcloud_alert',
  query: 'SELECT * FROM "IM_succ_sum" WHERE time > now() - 10m LIMIT 100',
}, context)
```

The adapter accepts only one bounded `SELECT` statement, rejects comments and mutations, limits the relative time window, flattens Influx `series` into rows, and reports the latest point timestamp as `watermark`. Endpoint URLs are logical configuration only; credentials must be supplied by the deployment environment or upstream network policy, never embedded in source.
