# Cap Infra MCP server

An MCP server for [Cap Infra](https://cap.so/docs/api/rest-api), the video and speech API. It lets an agent upload a video and get playback, share and embed links back, turn speech into text, and check what the app has spent.

It runs over stdio, needs Node 20 or newer and one environment variable, and talks only to the documented REST API. It does not need Cap Desktop or a Cap login.

Cap Infra also has a [hosted MCP server](https://cap.so/docs/api/get-started#10-use-with-agents-mcp) that needs no install. Use this one when the agent should upload a file from your disk in one call.

## Install

```bash
npx -y @cap.so/infra-mcp
```

The package is one self-contained file with no dependencies.

## Configure

| Variable | Required | Meaning |
|----------|----------|---------|
| `CAP_SECRET_KEY` | Yes | The secret key of your app, which starts with `csk_`. Copy it from the [console](https://cap.so/dashboard/infra). |
| `CAP_API_URL` | No | Where the API is served. Defaults to `https://cap.so`. Must be https, except on localhost. |

The server stops at startup with a message on stderr when the key is missing or is not a secret key. It never prints the key.

Claude Code:

```bash
claude mcp add cap-infra --env CAP_SECRET_KEY=csk_your_secret_key_here -- npx -y @cap.so/infra-mcp
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.cap-infra]
command = "npx"
args = ["-y", "@cap.so/infra-mcp"]
env = { CAP_SECRET_KEY = "csk_your_secret_key_here" }
tool_timeout_sec = 900
```

Any other client that starts a stdio server takes the same command and environment.

Keep the key in the client's own configuration. A secret key can create and delete everything in the app, so do not commit it.

## Tools

| Tool | What it does | Cost |
|------|--------------|------|
| `videos_upload` | Uploads a local file and starts encoding. Returns the video id with its share and embed links. Pass `videoId` to retry a failed upload into the same video. | Uploading and encoding are free. Stored video is billed one month when it becomes ready, then daily until deleted. |
| `videos_wait` | Waits until a video has its playback links or has failed, then returns status, length, playback id and the HLS, MP4, poster, share and embed links. Waits for both HLS and MP4 unless `output` asks for one. | Free |
| `videos_get` | Returns one video. | Free |
| `videos_list` | Lists videos, newest first, optionally for one `userId`, with `limit` and `offset`. | Free |
| `videos_delete` | Deletes a video and its files for good. | Stops its storage charge |
| `transcripts_create` | Creates a transcript from a public `url`, a local `path` or a ready `videoId`. | Billed per audio hour when it completes. A failed transcript is not charged. |
| `transcripts_wait` | Waits until a transcript is complete or has failed. Returns everything except the text. | Free |
| `transcripts_text` | Returns only the text. | Free |
| `transcripts_get` | Returns one transcript with its text, and with `words` or `segments` when asked. | Free |
| `transcripts_list` | Lists transcripts, newest first, by `userId` or `status`. | Free |
| `transcripts_delete` | Deletes a transcript, its text and its files for good. | Free |
| `account_usage` | Returns balance, standing, whether uploads are accepted, stored minutes, daily storage cost and rates. | Free |
| `account_transactions` | Lists the ledger, newest first. | Free |

There is no tool that adds credit. Buying credit needs a signed-in browser, so when the API answers that the app is out of credit, the result says so and carries the console link in `addCreditAt`. `account_usage` carries that link only when the app cannot take an upload or is in `grace` or `paused`.

## How it behaves

- Results are one compact JSON object. Lists carry only the fields an agent needs, plus `nextOffset` when there is another page.
- A failed call has `isError` set and an `error` object with the API's `code`, `message` and `hint`.
- The API limits how many requests each secret key can send a minute. Waits ask no more often than every 3 seconds and slow down from there, and every request waits for `Retry-After` when it is told to.
- A wait runs for up to 15 minutes. Pass `timeoutSeconds` to make it shorter. When the time runs out, the result has `timedOut` set with the id and the last known status, so the same call picks up where it stopped.
- Some clients end a tool call after a minute. Either raise that limit, as in the Codex example above, or pass a `timeoutSeconds` below it and call again.
- A video is `ready` when its first playback link exists, and the other link usually follows within seconds. `videos_wait` returns once both exist, or the one named in `output`. It allows the other link 30 seconds after `ready`, never past the deadline, and then returns the links that exist with `missing` naming the rest. That result is final and not a timeout: the video plays, and the missing link may not be coming. `transcripts_create` with a `videoId` that has no MP4 after 30 seconds answers `video_has_no_mp4` and says to use `path` or `url`.
- An upload that fails or is cancelled keeps its video. The result carries the `videoId`, a `videoStatus` and a `next` hint, and so does a log message and a line on stderr when the client cancelled. With `videoStatus` `uploading` the video has no file: retry with `videos_upload` and that `videoId`, or remove it with `videos_delete`. With `videoStatus` `unknown` the upload may have completed, so read it with `videos_get` before retrying or deleting.
- A transcript from a file that fails after the file was stored reports `transcriptStatus` `unknown`, because it may be running and may be billed. Check it with `transcripts_get` or `transcripts_wait` before deleting or creating it again.
- An upload reports progress in bytes when the client sends a progress token.
- The secret key, upload tokens and signed storage links never appear in a result or a log line.

## Develop

```bash
git clone https://github.com/CapSoftware/Cap.git
cd Cap
bun install
bun run --cwd packages/infra-mcp build
bun run --cwd packages/infra-mcp typecheck
bun run --cwd packages/infra-mcp test
```

The tests build the server, then drive it with a real MCP client against a stub of the API on localhost. They make no request to Cap. One test checks every method, path, query parameter and body field the server sends against the OpenAPI description in `apps/web/lib/developer-openapi.ts`, so the server cannot drift from the documented API.

`skill/SKILL.md` is a draft of the instructions an agent would get from a plugin or skill listing.

To publish, bump `version` in `package.json`, then:

```bash
bun run --cwd packages/infra-mcp pack:npm
npm publish packages/infra-mcp/npm --access public
```

`pack:npm` builds the server and writes the npm package to `packages/infra-mcp/npm` as `@cap.so/infra-mcp`. The workspace name stays `@cap/infra-mcp`, because the web app imports the hosted tools from it.
