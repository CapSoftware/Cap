import { emptyState, publicSnapshot } from "../../../lib/state";
import { getRedis, readState } from "../../../lib/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	if (new URL(request.url).search) {
		return Response.json(
			{ error: "Query parameters are not supported" },
			{ status: 400, headers: { "Cache-Control": "no-store" } },
		);
	}
	try {
		return Response.json(publicSnapshot(await readState(getRedis())), {
			headers: {
				"Cache-Control":
					"public, max-age=0, s-maxage=30, stale-while-revalidate=30",
			},
		});
	} catch {
		console.error("Status snapshot unavailable");
		return Response.json(publicSnapshot(emptyState()), {
			status: 503,
			headers: { "Cache-Control": "no-store" },
		});
	}
}
