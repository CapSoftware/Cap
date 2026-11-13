import { requireAdmin } from "@/lib/admin-access";
import { setDeveloperVideoTakedown } from "@/lib/developer-video-takedown-store";

const NO_STORE = { "Cache-Control": "no-store" };

function answer(status: number, body: unknown) {
	return Response.json(body, { status, headers: NO_STORE });
}

// The session cookie is SameSite=None, so a request is only taken as JSON
// from no origin (the staff script) or this one. A cross-site form cannot
// send JSON, and a cross-site fetch of it stops at the preflight.
function fromThisSite(request: Request): boolean {
	const type = request.headers.get("content-type") ?? "";
	if (!type.toLowerCase().startsWith("application/json")) return false;
	const origin = request.headers.get("origin");
	return origin === null || origin === new URL(request.url).origin;
}

export async function POST(request: Request) {
	if (!fromThisSite(request)) {
		return answer(400, { error: "Send JSON from the staff script." });
	}

	let admin: Awaited<ReturnType<typeof requireAdmin>>;
	try {
		admin = await requireAdmin();
	} catch {
		return answer(403, { error: "Not allowed." });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return answer(400, { error: "The body is not JSON." });
	}
	const { video, takenDown } = (body ?? {}) as {
		video?: unknown;
		takenDown?: unknown;
	};
	if (typeof video !== "string" || typeof takenDown !== "boolean") {
		return answer(400, {
			error:
				"Send { video, takenDown }: a playback id, video id or page URL, and true or false.",
		});
	}

	const result = await setDeveloperVideoTakedown(video, takenDown);
	if (!result) return answer(404, { error: "No video matches that." });

	console.info("[developer-video] Takedown changed", {
		by: admin.id,
		videoId: result.videoId,
		takenDown: result.takenDown,
		changed: result.changed,
	});
	return answer(200, { data: result });
}
