import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
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

	return NextResponse.json({
		success: true,
		...summary,
	});
}
