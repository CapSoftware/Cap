import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import {
	parseWorkerSaveState,
	validWorkerCallbackSecret,
	WORKER_SAVE_JOB_PREFIX,
	workerSaveOutput,
} from "@/lib/editor-worker-save";
import { attachRenderFarmJob } from "@/lib/render-farm-records";
import {
	abandonRenderFarmSave,
	finalizeRenderFarmSave,
	WORKER_SAVE_FAILED,
} from "@/lib/render-farm-save";

export const dynamic = "force-dynamic";

const MAX_CALLBACK_BYTES = 16 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** An editor worker reporting a Save it rendered and uploaded, or that failed. */
export async function POST(request: Request) {
	if (!validWorkerCallbackSecret(request.headers.get("x-media-server-secret")))
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	const text = await request.text();
	if (Buffer.byteLength(text) > MAX_CALLBACK_BYTES)
		return Response.json({ error: "Invalid callback" }, { status: 400 });
	let body: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null) throw new Error();
		body = parsed as Record<string, unknown>;
	} catch {
		return Response.json({ error: "Invalid callback" }, { status: 400 });
	}
	const { videoId, saveId, exportId } = body;
	const state = parseWorkerSaveState(body);
	if (
		typeof videoId !== "string" ||
		!ID.test(videoId) ||
		typeof saveId !== "string" ||
		typeof exportId !== "string" ||
		!ID.test(exportId) ||
		!state
	)
		return Response.json({ error: "Invalid callback" }, { status: 400 });
	const id = videoId as Video.VideoId;
	const [video] = await db()
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, id));
	const save = video?.metadata?.renderFarmSave;
	const jobId = `${WORKER_SAVE_JOB_PREFIX}${exportId}`;
	// A later Save or a withdrawal replaced this one.
	if (
		!save?.worker ||
		save.exportId !== saveId ||
		(save.jobId !== "" && save.jobId !== jobId)
	)
		return Response.json({ status: "stale" }, { status: 409 });
	if (save.jobId === "") await attachRenderFarmJob(id, saveId, jobId);
	const output = workerSaveOutput(state);
	if (output) {
		const finalized = await finalizeRenderFarmSave(id, jobId, output);
		return Response.json({ status: finalized });
	}
	if (state.status === "error") {
		console.warn(`[workerSave] ${videoId} failed: ${state.error}`);
		await abandonRenderFarmSave(id, save, { jobId }, WORKER_SAVE_FAILED);
		return Response.json({ status: "failed" });
	}
	return Response.json({ status: "rendering" });
}
