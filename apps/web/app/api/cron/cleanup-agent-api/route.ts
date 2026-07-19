import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { cleanupExpiredAgentApiRecords } from "@/lib/agent-api-cleanup";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const cronSecret = process.env.CRON_SECRET;
	if (!cronSecret) {
		return NextResponse.json(
			{ error: "Server misconfiguration" },
			{ status: 500 },
		);
	}

	const authorization = request.headers.get("authorization");
	const expected = `Bearer ${cronSecret}`;
	if (
		!authorization ||
		authorization.length !== expected.length ||
		!timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))
	) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const deleted = await cleanupExpiredAgentApiRecords();
	return NextResponse.json({ success: true, deleted });
}
