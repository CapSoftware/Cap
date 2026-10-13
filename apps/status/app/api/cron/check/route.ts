import { randomUUID, timingSafeEqual } from "node:crypto";
import { probe } from "../../../../lib/probe";
import { SERVICES, serviceUrl } from "../../../../lib/services";
import { applyResult, CHECK_INTERVAL_MS } from "../../../../lib/state";
import {
	COMMIT_SCRIPT,
	getRedis,
	LOCK_KEY,
	RELEASE_SCRIPT,
	readState,
	STATE_KEY,
} from "../../../../lib/store";

export const maxDuration = 50;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const secret = process.env.CRON_SECRET;
	const supplied = Buffer.from(request.headers.get("authorization") ?? "");
	const expected = Buffer.from(`Bearer ${secret}`);
	if (
		!secret ||
		supplied.length !== expected.length ||
		!timingSafeEqual(supplied, expected)
	) {
		return new Response("Unauthorized", { status: 401 });
	}
	if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production") {
		return Response.json({ skipped: "Preview deployment" });
	}
	try {
		const redis = getRedis();
		const owner = randomUUID();
		if (!(await redis.set(LOCK_KEY, owner, { nx: true, ex: 55 })))
			return Response.json({ skipped: "Check already running" });
		try {
			const state = await readState(redis);
			const now = Date.now();
			if (
				state.checkedAt &&
				Math.floor(Date.parse(state.checkedAt) / CHECK_INTERVAL_MS) >=
					Math.floor(now / CHECK_INTERVAL_MS)
			) {
				return Response.json({ skipped: "Check interval already sampled" });
			}
			const results = await Promise.all(
				SERVICES.map(async (service) => {
					try {
						const url = serviceUrl(service);
						return {
							id: service.id,
							result: url ? await probe(service, url) : null,
						};
					} catch {
						console.error(`Invalid monitor configuration: ${service.id}`);
						return { id: service.id, result: null };
					}
				}),
			);
			for (const { id, result } of results) applyResult(state, id, result, now);
			state.checkedAt = new Date(now).toISOString();
			const committed = await redis.eval(
				COMMIT_SCRIPT,
				[LOCK_KEY, STATE_KEY],
				[owner, JSON.stringify(state)],
			);
			if (committed !== 1) throw new Error("Monitor lease expired");
			return Response.json({
				checkedAt: state.checkedAt,
				checked: results.filter((entry) => entry.result).length,
			});
		} finally {
			await redis.eval(RELEASE_SCRIPT, [LOCK_KEY], [owner]);
		}
	} catch {
		console.error("Status check could not be saved");
		return Response.json({ error: "Monitoring unavailable" }, { status: 503 });
	}
}
