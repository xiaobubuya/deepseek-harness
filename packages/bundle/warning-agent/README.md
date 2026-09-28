description: "Controlled long-lived Runtime profile for incident investigation through Agent Gateway."
kind: "package-bundle"

# `@deepseek-ai/dsh-warning-agent`

English | [中文](README.zh.md)

## Summary

Use `dsh --profile warning-agent` for the controlled Runtime used by the early-warning hub. The profile keeps the Agent and workflow kernel, starts the internal Runtime ingress, and disables shell, filesystem, web, dynamic skill, and open-ended subagent capabilities. Runtime admission requires an HMAC signature from Agent Gateway; the process does not hold production data-source credentials.

## Runtime configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `WARNING_AGENT_HOST` | `0.0.0.0` | Internal listen address |
| `WARNING_AGENT_PORT` | `8090` | Internal listen port |
| `WARNING_AGENT_SHARED_SECRET` | empty | HMAC key; empty rejects every delivery |
| `WARNING_AGENT_CALLBACK_TIMEOUT_MS` | `3000` | Callback client timeout budget |
| `WARNING_AGENT_CALLBACK_RETRY_ATTEMPTS` | `3` | Maximum callback attempts for network/429/5xx failures |
| `WARNING_AGENT_CALLBACK_RETRY_BACKOFF_MS` | `250` | Initial exponential callback retry delay in milliseconds |
| `WARNING_AGENT_GATEWAY_CALLBACK_URL` | Gateway service URL | Fixed progress/result callback URL |
| `WARNING_AGENT_SESSION_DIR` | `/var/lib/warning-agent/sessions` | JSONL task projection directory |
| `WARNING_AGENT_MAX_CONCURRENT_TASKS` | `4` | Admission concurrency limit |
| `WARNING_AGENT_TASK_TIMEOUT_MS` | `600000` | Per-attempt runtime limit |
| `WARNING_AGENT_RETENTION_MS` | `604800000` | Terminal JSONL retention period |

The Runtime exposes `/health`, `/ready`, `POST /internal/warning-agent/v1/deliveries`, and the task cancellation endpoint. A delivery is deduplicated by `taskId + revision + attempt`; attempts for one revision share a deterministic Session id and have distinct workflow ids. Runtime lifecycle projections are appended to JSONL files on the mounted volume and progress/results are sent only to the configured Gateway URL.

The current MVP intentionally excludes domain query and POPO plugins. They will be added after the Gateway/Runtime protocol and deployment baseline are integrated.

## Source map

| File | Role |
| --- | --- |
| [`cordis.patch.yml`](cordis.patch.yml) | Explicit safe profile overlay over `dsh-base` |
| [`src/runtime.ts`](src/runtime.ts) | HMAC-verified Runtime HTTP server and delivery state |
| [`tests/runtime.spec.ts`](tests/runtime.spec.ts) | Health, signature, replay, and idempotency tests |

## Limitations

This profile is an internal service runtime, not a general-purpose coding agent. It does not execute system changes or access data sources directly. Warning Center remains the durable task and final-result authority; Runtime JSONL files are a local, recoverable execution projection and Gateway stays stateless.
