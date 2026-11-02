# Worm sharing server

A standalone Cloudflare Worker, private R2 bucket and static viewer. No Cap account, billing API, subscription or upstream web application is required. This first release is an owner-managed sharing service; public user signup is not implemented yet.

## Deploy your own

Use Node 22 or newer and your own Cloudflare account. The Jacks Unlimited instance is `capux.jaxtrell.workers.dev`; its resources are isolated from onCall.

```sh
cd apps/cloud
npm ci --ignore-scripts
npm run check
export CLOUDFLARE_ACCOUNT_ID=YOUR_ACCOUNT_ID
npx wrangler whoami
npx wrangler r2 bucket create capux-media --update-config=false
npx wrangler r2 bucket lifecycle add capux-media capux-retention '' --expire-days 31 --abort-multipart-days 1 --force
npm run deploy
npx wrangler secret put UPLOAD_TOKEN
```

At the secret prompt, supply a randomly generated credential of at least 32 characters. Save the same credential in Worm Settings → Sharing. Keep it in your password manager or system credential store; do not paste it into source, a recording, a URL or an issue. Requests to create shares return 503 until the secret is configured. Rotate it with the same secret command; existing links remain revocable with the new owner credential.

Change the Worker and bucket names in `wrangler.jsonc` for another instance. Set the deployment's returned HTTPS origin in the app. A custom domain can route to this same Worker later; API and viewer must share an origin so scoped playback cookies work. Never make the R2 bucket public. The 31-day retention rule applies only to this sharing bucket; it leaves source recordings on the user's computer untouched.

For local simulation, use the same config without remote bindings and a local `.dev.vars` containing only a synthetic UPLOAD_TOKEN. Tests run real workerd with ephemeral local R2 and assets; they do not call Cloudflare or upload personal recordings.

## Desktop and CLI

Sharing is off by default. Settings → Sharing controls the server, upload credential and expiry (1, 7 or 30 days). A recording's Share video action publishes only its finished video and copies the link. Studio recordings without an export need to be exported in the editor first. Screenshot Share publishes the composited PNG or JPEG. Revoke link stops access through that server; it does not delete the local recording.

```sh
cap sharing configure --server https://YOUR_WORKER.workers.dev --enable
cap sharing configure --token-stdin < /path/to/protected-credential
cap upload recording.mp4 --json
cap sharing status
cap sharing revoke SHARE_ID
```

Desktop and CLI read `~/.config/cap-ux/sharing.json`. Credentials are keyed by server origin in the system credential store. CAP_UX_UPLOAD_TOKEN supplies a headless credential; CAP_UX_SHARING_CONFIG selects an isolated configuration for testing. HTTPS is required except for localhost development. Redirects are refused so upload credentials cannot move to another endpoint. There is no Cap service fallback.

## Protocol v1

All JSON is bounded. Writes require `Authorization: Bearer <owner-upload-credential>`. All routes return private/no-store responses. No CORS grants are needed for the same-origin viewer or native client.

| Method and path | Result |
| --- | --- |
| GET /healthz | Product and protocol version |
| POST /api/v1/shares | Accept title, contentType, size and expiresInDays; return id, partSize, sharePath and expiresAt |
| PUT /api/v1/shares/ID/parts/N | Upload exactly the declared part size (final part can be smaller); return partNumber and etag |
| POST /api/v1/shares/ID/complete | Accept ordered parts; validate final size before publishing |
| DELETE /api/v1/shares/ID | Revoke access and remove the published media or abort an incomplete upload |
| GET /api/v1/shares/ID/metadata | Read title, size, content type and expiry with a read capability |
| GET or HEAD /api/v1/shares/ID/media | Authorized media; single byte ranges supported |
| POST /api/v1/shares/ID/access | Exchange the read capability for a scoped HttpOnly playback cookie bounded by link expiry |
| GET /s/ID#READ_CAPABILITY | Viewer; the fragment is exchanged for playback access and never sent in the HTTP URL |

The create response's link is not readable until completion. The viewer capability is distinct from the upload credential and stored as a hash. Possessing a viewing link never authorizes uploads or revocation. Revocation has an independent tombstone so a concurrent completion cannot restore access. Expiry is enforced on every read; the bucket lifecycle later removes stored objects. Clients verify the final media's size before reporting success, revoke incomplete/failed attempts, and keep local files.

Supported media: video/mp4, image/png and image/jpeg. Maximum media size: 20 GB. Multipart size: 8 MiB. Link expiry: 1–30 days. Raw traces, cookies, local configuration, API keys, notes and reports are not accepted as upload media. The current service has one administrative upload credential, not tenant accounts or a public upload form.

## Checks

`npm run check` regenerates binding types, typechecks, tests real R2 multipart/range/authorization/revocation behavior and packages a deployment dry run. `worker-configuration.d.ts` is generated, never edited manually. Native CI checks the shared Rust client, desktop and CLI and builds an isolated macOS preview.

The platform roadmap and capture handoff contract are in [CLOUD-PLATFORM.md](../../CLOUD-PLATFORM.md). Source remains available under the repository's [license](../../LICENSE).
