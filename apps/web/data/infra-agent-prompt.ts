export const CAP_INFRA_POINTER_PROMPT =
	"Read https://cap.so/infra and set up Cap Infra for this project.";

export const CAP_INFRA_AGENT_PROMPT = `Set up Cap Infra in this project so it can upload and play video.

Cap Infra is Cap's video API (https://cap.so/infra). Use the Cap CLI for the account side and the documented HTTP API for the code. Do not guess. Check every command with cap guide --json or cap <command> --help, and take every request from https://cap.so/docs/api/rest-api (OpenAPI at https://cap.so/openapi.json). Use only the endpoints documented there.

1. Find the Cap CLI. Run cap version --json. If cap is missing, install it yourself:
   - macOS or Linux: curl -fsSL https://cap.so/install-cli.sh | sh
   - Windows PowerShell: irm https://cap.so/install-cli.ps1 | iex
2. Sign in. Run cap auth status --json. Developer apps need the full profile, so if it is missing run cap auth login --profile full --json and let me approve it in the browser.
3. Choose an app. Run cap developers list --json, then ask me whether to create a new app or use one that exists. Wait for my answer.
4. Get the keys without showing them. A new app returns its public key (cpk_) and secret key (csk_) once, from cap developers create "<name>" --yes --json. An existing app only returns keys from cap developers keys rotate <app> --yes --json, which revokes the current pair, so confirm with me first. Redirect that output to a temporary file. Never let it reach the chat, the terminal or a log.
5. Store the keys. Write both into this project's local environment file, using the names the project already uses or CAP_PUBLIC_KEY and CAP_SECRET_KEY. Check the file is ignored by git, then delete the temporary file. The public key may be used in the browser. The secret key stays on the server and is never printed or committed.
6. Wire up uploads with the public key: create a video, upload the file with the multipart endpoints, then complete the upload.
7. Wire up playback. From the server, with the secret key, check the video's status until it is ready, then show it with the embed URL returned when the video was created.
8. If a request returns 402 the app is out of credits. Tell me, and offer cap developers credits purchase <app> --amount-cents <cents>, which opens a checkout for me to pay. Before production, add each site with cap developers domains add <app> <domain>.

Finish by running cap developers videos list <app> --json to confirm the upload arrived. Tell me what you changed and where the keys live, then ask what I want to build next.`;
