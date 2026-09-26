import type { Video } from "@cap/web-domain";
import { renderFarmConfig, verifyRenderFarmSignature } from "@/lib/render-farm";
import {
	failRenderFarmSave,
	finalizeRenderFarmSave,
} from "@/lib/render-farm-save";

export const dynamic = "force-dynamic";

const MAX_CALLBACK_BYTES = 16 * 1024;

export async function POST(request: Request) {
	const config = renderFarmConfig();
	if (!config?.callbackSecret) {
		return Response.json({ error: "Unavailable" }, { status: 503 });
	}
	const body = await request.text();
	if (
		Buffer.byteLength(body) > MAX_CALLBACK_BYTES ||
		!verifyRenderFarmSignature(
			body,
			request.headers.get("x-render-farm-signature"),
			config.callbackSecret,
		)
	) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	let payload: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed !== "object" || parsed === null) throw new Error();
		payload = parsed as Record<string, unknown>;
	} catch {
		return Response.json({ error: "Invalid callback" }, { status: 400 });
	}
	const { id, reference, status } = payload;
	if (typeof id !== "string" || typeof reference !== "string") {
		return Response.json({ error: "Invalid callback" }, { status: 400 });
	}
	const videoId = reference as Video.VideoId;
	try {
		if (status === "ready") {
			await finalizeRenderFarmSave(videoId, id, {
				width: Number(payload.width),
				height: Number(payload.height),
				fps: Number(payload.fps),
				durationSeconds: Number(payload.durationSeconds),
				bytes: Number(payload.bytes),
			});
		} else if (status === "error") {
			await failRenderFarmSave(
				videoId,
				id,
				typeof payload.error === "string" ? payload.error : "Export failed",
			);
		}
	} catch (error) {
		console.error("Render farm callback could not be applied", error);
		return Response.json({ error: "Retry later" }, { status: 503 });
	}
	return Response.json({ ok: true });
}
