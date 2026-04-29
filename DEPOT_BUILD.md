# Depot Build — cap-web

Local Docker build of `apps/web` OOMs on Docker Desktop default RAM. Use Depot remote builder instead.

## Prereqs

- `depot` CLI installed (`brew install depot/tap/depot`)
- `.env` with:
  ```
  export DEPOT_DEV_API_KEY=depot_org_...
  export DEPOT_DEV_ORG_ID=..
  export DEPOT_DEV_PROJECT_ID=...
  ```

## Build + load into local Docker

```bash
source .env
DEPOT_TOKEN=$DEPOT_DEV_API_KEY \
  depot build \
    --project $DEPOT_DEV_PROJECT_ID \
    -f apps/web/Dockerfile \
    -t cap-web:local \
    --load \
    .
```

Flags:
- `--project` — Depot project ID (org token alone insufficient).
- `--load` — pull built image into local Docker daemon as `cap-web:local`.
- Build context = repo root (Dockerfile does `COPY . .`).

## Verify

```bash
docker images cap-web:local
```

## Use in compose

`docker-compose.yml` references `cap-web:local`. Bring up:

```bash
docker compose up -d --force-recreate cap-web
```

## Push to registry (optional)

```bash
DEPOT_TOKEN=$DEPOT_DEV_API_KEY \
  depot build \
    --project $DEPOT_DEV_PROJECT_ID \
    -f apps/web/Dockerfile \
    -t ghcr.io/<org>/cap-web:<tag> \
    --push \
    .
```

## Notes

- Org token (`depot_org_...`) works for `depot build` with `--project`. Does NOT work for `depot projects list` (user-scoped).
- Local `docker build` fails: `ResourceExhausted: cannot allocate memory` during Next.js build. Bump Docker Desktop RAM to 12GB+ if you want local build.
- `--no-cache` on `docker compose build` skips `cap-web` because compose entry uses `image:` not `build:`. Depot is the build path.
