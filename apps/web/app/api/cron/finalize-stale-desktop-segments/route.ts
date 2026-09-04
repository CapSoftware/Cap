import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getDesktopRecordingHealth } from "@/lib/desktop-recording-health";
import { recoverStaleDesktopSegments } from "@/lib/desktop-segments-recovery";

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

	const summary = await recoverStaleDesktopSegments();
	const health = await getDesktopRecordingHealth();
	const healthy =
		health.status === "healthy" && (summary.statuses.failed ?? 0) === 0;
	if (!healthy) {
		console.error("[recording-health] Processing needs attention", {
			...health,
			recoveryFailures: summary.statuses.failed ?? 0,
		});
	}

	return NextResponse.json(
		{
			success: healthy,
			...summary,
			health,
		},
		{ status: healthy ? 200 : 503 },
	);
}
