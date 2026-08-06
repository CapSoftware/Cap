import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { recoverStalledVideoPipeline } from "@/lib/video-pipeline-recovery";
import { recoverFailedVideoProcessing } from "@/lib/video-processing-recovery";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const cronSecret = process.env.CRON_SECRET;
	if (!cronSecret) {
		return NextResponse.json(
			{ error: "Server misconfiguration" },
			{ status: 500 },
		);
	}

	const authHeader = request.headers.get("authorization");
	const expected = `Bearer ${cronSecret}`;
	if (
		!authHeader ||
		authHeader.length !== expected.length ||
		!timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
	) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const [summary, stalledPipeline] = await Promise.all([
		recoverFailedVideoProcessing(),
		recoverStalledVideoPipeline(),
	]);

	return NextResponse.json({
		success: true,
		...summary,
		stalledPipeline,
	});
}
