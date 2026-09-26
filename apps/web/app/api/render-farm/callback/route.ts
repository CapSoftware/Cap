import type { Video } from "@cap/web-domain";
import {
	parseRenderFarmReference,
	renderFarmConfig,
	verifyRenderFarmSignature,
} from "@/lib/render-farm";
import {
	clearRecordingRender,
	failRenderFarmSave,
} from "@/lib/render-farm-records";
import {
	failRenderFarmExport,
	finalizeRenderFarmExport,
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
	const target = parseRenderFarmReference(reference);
	if (!target) {
		return Response.json({ error: "Invalid callback" }, { status: 400 });
	}
	const videoId = target.videoId as Video.VideoId;
	const error =
		typeof payload.error === "string" ? payload.error : "Export failed";
	try {
		if (status === "ready") {
			const output = {
				width: Number(payload.width),
				height: Number(payload.height),
				fps: Number(payload.fps),
				durationSeconds: Number(payload.durationSeconds),
				bytes: Number(payload.bytes),
			};
			if (target.kind === "export") {
				await finalizeRenderFarmExport(videoId, id, output);
			} else {
				await finalizeRenderFarmSave(videoId, id, output);
			}
		} else if (status === "error") {
			if (target.kind === "export") {
				await failRenderFarmExport(videoId, id, error);
			} else if (target.kind === "recording") {
				await clearRecordingRender(videoId, { jobId: id });
			} else {
				await failRenderFarmSave(videoId, { jobId: id }, error);
			}
		}
	} catch (error) {
		console.error("Render farm callback could not be applied", error);
		return Response.json({ error: "Retry later" }, { status: 503 });
	}
	return Response.json({ ok: true });
}
