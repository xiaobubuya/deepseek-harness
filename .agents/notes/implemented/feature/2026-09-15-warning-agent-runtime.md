# warning-agent Runtime admission

## Decision

The Harness warning-agent profile uses an explicit overlay over `dsh-base`. Development-oriented shell, filesystem, web, skill, and open-ended subagent rows are disabled at the final profile layer. The profile adds a long-lived HTTP Runtime that accepts only signed Gateway deliveries and deduplicates them by `taskId + revision`.

## Consequences

The Runtime owns admission and execution projection only. Agent Gateway owns authorization, production data access, durable task state, Session Persistence, callback persistence, and retry policy. An empty shared secret rejects all deliveries, so a deployment must inject the secret through its runtime secret manager.

## Verification

`packages/bundle/warning-agent/tests/runtime.spec.ts` covers health/readiness, HMAC verification, replay rejection, and delivery idempotency. The profile's final composition still requires a dump-config assertion before production deployment.
