import type { NextRequest } from "next/server";
import { getVideoAnalytics } from "@/actions/videos/get-analytics";

const parseRangeParam = (value: string | null) => {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const normalized = trimmed.endsWith("d") || trimmed.endsWith("D")
		? trimmed.slice(0, -1)
		: trimmed;
	const parsed = Number.parseInt(normalized, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
	return parsed;
};

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
	const url = new URL(request.url);
	const videoId = url.searchParams.get("videoId");
	const rangeParam = url.searchParams.get("range");
	const rangeDays = parseRangeParam(rangeParam);

	if (!videoId) {
		return Response.json({ error: "Video ID is required" }, { status: 400 });
	}

	try {
		console.log("videoId", videoId);
		const result = await getVideoAnalytics(videoId, { rangeDays });
		console.log("result", result);
		return Response.json({ count: result.count }, { status: 200 });
	} catch (error) {
		console.error("Error fetching video analytics:", error);
		return Response.json(
			{ error: "Failed to fetch analytics" },
			{ status: 500 },
		);
	}
}
