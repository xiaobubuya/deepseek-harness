# Agent Gateway

Java 21 and Spring Boot 3 stateless forwarding process for Warning Center and the `warning-agent` Runtime.

The service exposes task submission and cancellation to Warning Center, signs fixed-target Runtime requests with HMAC-SHA256, verifies Runtime callbacks, and forwards callbacks to one configured Warning Center URL. It intentionally has no database, task state, Session storage, queue, lease, Outbox, or domain query proxy.

## Endpoints

- `POST /api/v1/agent/tasks`
- `POST /api/v1/agent/tasks/{taskId}/cancel`
- `POST /internal/agent-gateway/v1/task-events`
- `GET /actuator/health/liveness`
- `GET /actuator/health/readiness`

Warning Center calls require `X-Internal-Token`. Runtime requests and callbacks use `X-Warning-Agent-Timestamp`, `X-Warning-Agent-Nonce`, and `X-Warning-Agent-Signature`. Runtime and Warning Center destinations come only from process configuration; request payloads cannot override them.

## Local verification

```sh
mvn test
```
