import { pathToFileURL } from "node:url";

const USAGE = `Take a Cap Infra video down, restore it, or delete it.

  bun scripts/infra-video-takedown.ts down <video>
  bun scripts/infra-video-takedown.ts restore <video>
  bun scripts/infra-video-takedown.ts delete <video>

delete takes the video down, deletes it as its owner would and removes its
files at once, so links already handed out stop working. It cannot be undone.

<video> is a playback id, a video id, or the hosted, embed or playback URL.

Environment:
  CAP_SESSION_TOKEN  the next-auth.session-token cookie of a signed-in Cap staff account
  CAP_URL            the Cap web app to call, https://cap.so by default`;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

type TakedownAnswer = {
	data?: {
		videoId: string;
		appId: string;
		playbackId: string | null;
		takenDown?: boolean;
		changed?: boolean;
		alreadyDeleted?: boolean;
		filesPurged?: boolean;
	};
	error?: string;
};

export function parseTakedownArgs(
	argv: readonly string[],
):
	| { video: string; takenDown: boolean }
	| { video: string; delete: true }
	| null {
	const [action, video, ...rest] = argv;
	if (rest.length > 0 || !video) return null;
	if (action === "delete") return { video, delete: true };
	if (action !== "down" && action !== "restore") return null;
	return { video, takenDown: action === "down" };
}

export async function runTakedown({
	argv,
	env,
	fetchImpl = fetch,
	log,
	fail,
}: {
	argv: readonly string[];
	env: Record<string, string | undefined>;
	fetchImpl?: Fetch;
	log: (line: string) => void;
	fail: (line: string) => void;
}): Promise<number> {
	const parsed = parseTakedownArgs(argv);
	if (!parsed) {
		fail(USAGE);
		return 2;
	}
	const token = env.CAP_SESSION_TOKEN;
	if (!token) {
		fail("Set CAP_SESSION_TOKEN to a staff session cookie.");
		return 2;
	}
	const base = (env.CAP_URL || "https://cap.so").replace(/\/+$/, "");
	const response = await fetchImpl(
		`${base}/api/admin/developer-video-takedown`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Cookie: `next-auth.session-token=${token}`,
			},
			body: JSON.stringify(parsed),
		},
	);
	const body = (await response
		.json()
		.catch(() => null)) as TakedownAnswer | null;
	const data = body?.data;
	if (!response.ok || !data) {
		fail(`${response.status}: ${body?.error ?? "unexpected answer"}`);
		return 1;
	}
	const name = `${data.videoId} (playback ${data.playbackId ?? "none"}, app ${data.appId})`;
	if ("delete" in parsed) {
		const files = data.filesPurged
			? "its files are removed"
			: "its files could not be removed yet and the purge job will retry";
		log(
			`${name} is deleted${data.alreadyDeleted ? " (it already was)" : ""}, and ${files}.`,
		);
		return data.filesPurged ? 0 : 1;
	}
	const state = data.takenDown ? "taken down" : "playing normally";
	log(`${name} is ${state}${data.changed ? "" : ", unchanged"}.`);
	return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
	process.exitCode = await runTakedown({
		argv: process.argv.slice(2),
		env: process.env,
		log: (line) => console.log(line),
		fail: (line) => console.error(line),
	});
}
