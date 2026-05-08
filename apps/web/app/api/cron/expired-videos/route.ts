import { timingSafeEqual } from "node:crypto";
import { Videos } from "@cap/web-backend";
import { Effect } from "effect";
import { NextResponse } from "next/server";
import { runPromise } from "@/lib/server";

export const dynamic = "force-dynamic";

const isAuthorized = (request: Request, cronSecret: string) => {
	const authHeader = request.headers.get("authorization");
	const expected = `Bearer ${cronSecret}`;

	return (
		authHeader?.length === expected.length &&
		timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
	);
};

export async function GET(request: Request) {
	const cronSecret = process.env.CRON_SECRET;
	if (!cronSecret) {
		return NextResponse.json(
			{ error: "Server misconfiguration" },
			{ status: 500 },
		);
	}

	if (!isAuthorized(request, cronSecret)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const result = await Effect.flatMap(Videos, (videos) =>
		videos.deleteExpired(100),
	).pipe(runPromise);

	return NextResponse.json({
		success: true,
		...result,
	});
}
