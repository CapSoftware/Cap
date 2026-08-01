import { timingSafeEqual } from "node:crypto";
import { Tinybird } from "@cap/web-backend";
import { Effect } from "effect";
import { NextResponse } from "next/server";
import { runPromise } from "@/lib/server";

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

	const result = await runPromise(
		Effect.gen(function* () {
			const tinybird = yield* Tinybird;
			return yield* tinybird.recoverProductAnalyticsErasure;
		}),
	);
	return NextResponse.json({ success: true, ...result });
}
