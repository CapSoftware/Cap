import { MAX_LOOM_CSV_IMPORT_ROWS } from "@/lib/loom-csv";

const CAP_CLOUD_ORIGIN = "https://cap.so";

export function buildLoomAgentMigrationPrompt({
	organizationId,
	organizationName,
	userEmail,
	origin,
}: {
	organizationId: string;
	organizationName: string;
	userEmail: string;
	origin: string;
}) {
	const serverOrigin = origin.replace(/\/+$/, "") || CAP_CLOUD_ORIGIN;
	const isCapCloud = serverOrigin === CAP_CLOUD_ORIGIN;
	const importPage = `${serverOrigin}/dashboard/import/loom`;

	return `Migrate my Loom workspace into Cap.

Cap organization: ${organizationName}
Cap organization ID: ${organizationId}
My Cap account: ${userEmail}
Cap import page: ${importPage}

Do the work yourself. Only stop when I need to sign in, export something from Loom, or approve the import plan.

1. Set up the Cap CLI
- If \`cap\` is not installed, install it with \`curl -fsSL https://cap.so/install-cli.sh | sh\` on macOS or Linux, or \`irm https://cap.so/install-cli.ps1 | iex\` in Windows PowerShell, then open a new shell.${
		isCapCloud
			? ""
			: `\n- This Cap server is self-hosted. Set \`CAP_SERVER_URL=${serverOrigin}\` for every \`cap\` command.`
	}
- Run \`cap auth status --json\`. Assigning videos to teammates and spaces needs the admin profile, so if it is missing run \`cap auth login --profile admin --json\` and wait while I approve it in the browser.
- Run \`cap guide --json\` and check the flags for \`cap caps import loom\` in this version.

2. Get the full list of Loom videos
- Ask me to export it while signed in to Loom as a workspace admin: Settings, Workspace, Data, then Export engagement insights. The date range defaults to recent videos only, so I should set the start date before our first Loom video and download the CSV.
- If I give you a different CSV or a list of Loom links instead, use that.
- The columns you need are Video Link, Creator Email, Folder, Public and Has Password?. Never download the videos yourself, Cap fetches them from Loom.

3. Plan the import and confirm it with me
- Import one Loom video per command. The owner is the creator email and the Cap space is the Loom folder. Leave the space out when the folder is empty.
- Private or password-protected Loom videos cannot be imported. List them so I can make them viewable by link in Loom, or skip them.
- Creators who are not in the Cap organization yet are added as members when their first video imports.
- Show me the number of videos, owners, spaces and skipped videos, then wait for my go-ahead.
- If there are more than ${MAX_LOOM_CSV_IMPORT_ROWS.toLocaleString("en-US")} videos, also suggest requesting a concierge migration on the Cap import page so the Cap team can run it for us.

4. Run the import
- For each video run:
  cap caps import loom "<loom url>" --organization ${organizationId} --owner-email "<creator email>" --space "<folder>" --yes --format json
- Run one video at a time with about 2 seconds between commands. Loom limits how quickly videos can be fetched.
- If the error code is RATE_LIMITED or TEMPORARY_UNAVAILABLE, wait retryAfterMs (60 seconds when it is missing) and retry the same video. Double the wait each time it happens again in a row, up to 10 minutes.
- CONFLICT means Cap already has an import of that Loom video, but the earlier import may have failed. Record it as already in Cap, not as imported, and check it in step 5.
- Any other error is permanent for that video. Record the message and move on.
- Keep a progress file with one line per Loom URL and its result, and skip finished URLs when resuming, so the run can be stopped and restarted safely.

5. Report back
- Videos keep processing in Cap after each command returns.
- For every video recorded as already in Cap, find it with \`cap caps list --organization ${organizationId} --search "<video name>" --format json\` and check it with \`cap caps status <cap id> --format json\`. Count it as done only if it finished processing. Otherwise list it as failed so I can delete it in Cap and run it again.
- When every video has been tried and checked, tell me how many were imported, already in Cap, failed and skipped, and list each failed URL with its error.`;
}
