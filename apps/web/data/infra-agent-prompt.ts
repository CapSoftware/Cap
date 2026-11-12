const commands = {
	version: "cap version --json",
	guide: "cap guide --json",
	videosHelp: "cap developers videos --help",
	update: "cap update --json",
	agentsInstall:
		"cap agents install --target <claude|codex|cursor> --component all --yes --json",
	authStatus: "cap auth status --json",
	authLogin: "cap auth login --profile full --json",
	list: "cap developers list --json",
	create: 'cap developers create "<name>" --yes --json',
	rotatePreview: "cap developers keys rotate <app> --dry-run --json",
	rotate: "cap developers keys rotate <app> --yes --json",
	upload: "cap developers videos upload <app> <file> --wait --yes --json",
	videoGet: "cap developers videos get <app> <video> --json",
	videoDelete: "cap developers videos delete <app> <video> --yes --json",
	usage: "cap developers usage <app> --json",
	purchase:
		"cap developers credits purchase <app> --amount-cents 1000 --no-open --yes --json",
} as const;

export const CAP_INFRA_AGENT_COMMANDS: readonly string[] =
	Object.values(commands);

export const CAP_INFRA_AGENT_PROMPT = `Set up Cap Infra in this project so it can upload and play video.

Cap Infra is Cap's video API. Use the Cap CLI for the account side and the documented HTTP API for the code. Do not guess. Check every command with ${commands.guide} or by adding --help to it, and take every request from https://cap.so/docs/api/rest-api (OpenAPI at https://cap.so/openapi.json). Use only the endpoints documented there. You run without a terminal prompt, so a command that changes something needs --yes. Pass it only after I agreed to that change.

1. Find the Cap CLI. Run ${commands.version}. If the command is missing, install it yourself:
   - macOS or Linux: curl -fsSL https://cap.so/install-cli.sh | sh
   - Windows PowerShell: irm https://cap.so/install-cli.ps1 | iex
   Then run ${commands.videosHelp}. If it does not list upload, get and wait, run ${commands.update} and check again. If they are still missing, tell me, skip step 9 and check the upload through the HTTP API instead.
2. Connect Cap to yourself. Run ${commands.agentsInstall} with the one target that names you. This adds the Cap MCP server and skill. They load the next time you start, so keep using the CLI for the rest of this setup.
3. Sign in. Run ${commands.authStatus}. Developer apps need the developer:read, developer:write and developer:secrets scopes. If scopes does not list them, run ${commands.authLogin}, let me approve it in the browser, then check the status again.
4. Choose an app. Run ${commands.list}, then ask me whether to create a new app or use one that exists. Wait for my answer.
5. Get the keys without showing them. A new app returns its public key (cpk_) and secret key (csk_) once, from ${commands.create}. The keys of an existing app cannot be read again, so ask me to put them in the environment file myself. Only if I agree to revoke the keys in use, run ${commands.rotatePreview} to show me which keys would stop working, then ${commands.rotate}. Redirect the output of create or rotate to a temporary file. Never let it reach the chat, the terminal or a log.
6. Store the keys. Write both into this project's local environment file, using the names the project already uses or CAP_PUBLIC_KEY and CAP_SECRET_KEY. Check the file is ignored by git, then delete the temporary file. The secret key stays on the server and is never printed, committed or sent to a browser. The public key cannot create or upload videos.
7. Wire up uploads. On the server, with the secret key, create an upload (POST /api/developer/v1/uploads) only for a signed-in user, and return its upload token (cut_) to the browser. In the browser, with that token as the Bearer credential, upload the file with the multipart endpoints, then complete the upload. Never send a key to the browser.
8. Wire up playback. From the server, with the secret key, check the video's status until it is ready, then show it with the embed URL returned when the upload was created.
9. Prove the app works. Ask me first, because stored video is billed daily. ${commands.upload} uploads a short test video and returns once its status is ready, with its shareUrl and embedUrl. If it fails or times out, the error still carries the videoId. ${commands.videoGet} reads the same fields later. Give me the shareUrl, and once I have seen it remove the test video with ${commands.videoDelete}.
10. Watch the credits. ${commands.usage} shows the balance and whether uploads are allowed. If a request returns 402 or INSUFFICIENT_CREDITS the app is out of credits. Tell me, and offer ${commands.purchase}, which returns a checkout link for me to pay. The amount is in cents, from 500 ($5) to 100000 ($1,000). Before production, set corsOrigin to the site's origin when you create each upload.

Finish by telling me what you changed, where the keys live and the share link of the test video, then ask what I want to build next.`;
