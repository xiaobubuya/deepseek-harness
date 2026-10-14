# Warning Agent deployment

This Compose project runs two independent processes:

- `agent-gateway`: the only published HTTP port, stateless Java 21 gateway;
- `warning-agent-runtime`: internal Node.js Harness profile with a named JSONL volume.

The first read-only domain tools are included in the Runtime: LPS process/metric
configuration, Doris table/schema/query, and NTSDB query. Decision-result,
Sentinel write actions, and POPO team operations are intentionally not included.

## Start locally

Create `.env` from `.env.example`, replace all required placeholders, then run:

```sh
docker compose --env-file deploy/warning-agent/.env \
  -f deploy/warning-agent/docker-compose.yml up --build
```

Do not commit `.env`. Production deployments should inject the internal token and shared HMAC secret from the platform secret manager and should use immutable image tags.

The Runtime also needs the read-only data-source settings from `.env.example`:
`WARNING_LPS_BASE_URL`/`WARNING_LPS_API_KEY`,
`WARNING_DORIS_BASE_URL`/`WARNING_DORIS_API_KEY`, and
`WARNING_NTSDB_ENDPOINTS_JSON`. `WARNING_DATA_REQUIRE_TENANT` defaults to
`true`; set it to `false` only for an isolated local smoke test.

The Harness model provider also needs `DEEPSEEK_API_KEY` in the Runtime
container. The Gateway and Runtime can start without a Warning Center process,
but task result callbacks will then be retried and eventually dropped.

The Runtime image launches through the supported `dsh --profile warning-agent` entrypoint. Only Gateway publishes a host port; Runtime port `8090` stays on the Compose network. Session projections survive Runtime container replacement in the `warning-agent-sessions` named volume.

## Publish images to Harbor

The Harbor project page uses the numeric project id in its URL, but image names
must use the project's namespace. Confirm that namespace in the project page or
with an authenticated Harbor API request before tagging images:

```sh
curl -u "$HARBOR_USER" -k \
  https://harbor.we.service.gy.ntes/api/v2.0/projects/24
```

Log in to the registry host (the `/harbor` path is only the web UI path), and
choose an immutable release tag such as a date plus Feature number:

```sh
podman machine start podman-machine-default
podman login harbor.we.service.gy.ntes

export HARBOR_PROJECT=<project-namespace-from-harbor>
export RELEASE_TAG=20260929-f006
export REGISTRY=harbor.we.service.gy.ntes
export GATEWAY_IMAGE="$REGISTRY/$HARBOR_PROJECT/agent-gateway:$RELEASE_TAG"
export RUNTIME_IMAGE="$REGISTRY/$HARBOR_PROJECT/warning-agent-runtime:$RELEASE_TAG"
```

Build and push the two independent processes:

```sh
podman build --format docker -t "$GATEWAY_IMAGE" services/agent-gateway
podman build --format docker -t "$RUNTIME_IMAGE" \
  -f deploy/warning-agent/Dockerfile.runtime .

podman push "$GATEWAY_IMAGE"
podman push "$RUNTIME_IMAGE"
```

The local machine in this repository is Apple Silicon (`linux/arm64`). If the
deployment nodes are x86-64, build with the target platform and ensure Podman
has an amd64 emulation handler:

```sh
pnpm install --frozen-lockfile
pnpm exec tsc -b apps/cli/tsconfig.json packages/bundle/warning-agent/tsconfig.json --pretty false
pnpm exec tsdown --config apps/cli/tsdown.config.ts

podman build --platform linux/amd64 --format docker -t "$GATEWAY_IMAGE" services/agent-gateway
podman build --platform linux/amd64 --format docker -t "$RUNTIME_IMAGE" \
  --build-arg BUILD_RUNTIME_ARTIFACTS=false \
  -f deploy/warning-agent/Dockerfile.runtime .
```

The host-side TypeScript/CLI build is intentional: running `tsdown` through
QEMU can crash on Apple Silicon, while the Runtime image still installs all
native dependencies for `linux/amd64`.

On the deployment host, set the two image variables in `.env` to the pushed
names and pull the release:

```sh
# Install a Compose provider first when `podman compose` reports no provider.
# macOS: brew install podman-compose
# Linux: install podman-compose with the distribution package manager.
podman login harbor.we.service.gy.ntes
AGENT_GATEWAY_IMAGE="$GATEWAY_IMAGE" \
WARNING_AGENT_RUNTIME_IMAGE="$RUNTIME_IMAGE" \
  podman compose --env-file deploy/warning-agent/.env \
    -f deploy/warning-agent/docker-compose.yml pull
podman compose --env-file deploy/warning-agent/.env \
  -f deploy/warning-agent/docker-compose.yml up -d
```

Do not put Harbor passwords, `DEEPSEEK_API_KEY`, callback tokens, or data-source
credentials in `.env.example`, shell history, or Git. Inject them from the
deployment secret manager; `.env` is local-only and must remain untracked.

## Smoke test

After both containers are healthy, check the published Gateway and submit one
read-only investigation task:

```sh
curl -fsS http://127.0.0.1:${AGENT_GATEWAY_PUBLISHED_PORT:-8080}/actuator/health/readiness

curl -i -X POST http://127.0.0.1:${AGENT_GATEWAY_PUBLISHED_PORT:-8080}/api/v1/agent/tasks \
  -H 'Content-Type: application/json' \
  -H "X-Internal-Token: ${AGENT_GATEWAY_WARNING_CENTER_TOKEN}" \
  -H 'X-Request-Id: smoke-warning-001' \
  --data @- <<'JSON'
{
  "schemaVersion": "v1",
  "taskId": "smoke-warning-001",
  "incidentId": "smoke-incident-001",
  "taskType": "investigate",
  "revision": 1,
  "attempt": 1,
  "priority": "P2",
  "deadlineAt": "2030-01-01T00:00:00Z",
  "allowedTools": ["lps_get_processes", "lps_get_metrics", "doris_query", "ntsdb_query"],
  "context": {
    "tenantId": "local-smoke",
    "traceId": "smoke-trace-001",
    "question": "Check the configured warning data sources and summarize any evidence."
  }
}
JSON
```

The submission should return `202`. The Gateway forwards it to Runtime and
Runtime calls the configured Warning Center callback with the final result. For
a local-only smoke test, point
`AGENT_GATEWAY_WARNING_CENTER_CALLBACK_URL` at a small HTTP mock; otherwise the
task can still execute, but its result callback will be retried and discarded
when no Warning Center is available.

For example, the following mock accepts callbacks on macOS/Docker Desktop (the
Compose file also maps `host.docker.internal` for Linux Docker):

```sh
node -e 'require("node:http").createServer((req,res)=>{let b="";req.on("data",c=>b+=c);req.on("end",()=>{console.log(b);res.writeHead(202);res.end()})}).listen(18081)'
```

Set `AGENT_GATEWAY_WARNING_CENTER_CALLBACK_URL` to
`http://host.docker.internal:18081/internal/v1/warning-agent/task-events`
before `docker compose up`.
