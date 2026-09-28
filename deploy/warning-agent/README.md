# Warning Agent deployment

This Compose project runs two independent processes:

- `agent-gateway`: the only published HTTP port, stateless Java 21 gateway;
- `warning-agent-runtime`: internal Node.js Harness profile with a named JSONL volume.

Domain query and POPO plugins are intentionally not included in this MVP.

## Start locally

Create `.env` from `.env.example`, replace all required placeholders, then run:

```sh
docker compose --env-file deploy/warning-agent/.env \
  -f deploy/warning-agent/docker-compose.yml up --build
```

Do not commit `.env`. Production deployments should inject the internal token and shared HMAC secret from the platform secret manager and should use immutable image tags.

The Runtime image launches through the supported `dsh --profile warning-agent` entrypoint. Only Gateway publishes a host port; Runtime port `8090` stays on the Compose network. Session projections survive Runtime container replacement in the `warning-agent-sessions` named volume.
