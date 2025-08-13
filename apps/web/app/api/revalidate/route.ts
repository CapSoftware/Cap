import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";
import { CACHE_CONTROL_HEADERS, getHeaders } from "@/utils/helpers";

export async function POST(request: NextRequest) {
	const origin = request.headers.get("origin") as string;

	try {
		const { videoId } = await request.json();

		if (!videoId) {
			return new Response(JSON.stringify({ error: "Missing videoId" }), {
				status: 400,
				headers: {
					...getHeaders(origin),
					...CACHE_CONTROL_HEADERS,
				},
			});
		}

		const [video] = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, videoId));

		if (!video) {
			return new Response(JSON.stringify({ error: "Video not found" }), {
				status: 404,
				headers: {
					...getHeaders(origin),
					...CACHE_CONTROL_HEADERS,
				},
			});
		}

		// Revalidate the specific video page
		revalidatePath(`/s/${videoId}`);

		return new Response(
			JSON.stringify({
				revalidated: true,
				now: Date.now(),
				path: `/s/${videoId}`,
			}),
			{
				headers: {
					...getHeaders(origin),
					...CACHE_CONTROL_HEADERS,
				},
			},
		);
	} catch (err) {
		console.error("Revalidation error:", err);
		return new Response(
			JSON.stringify({
				error: "Error revalidating",
				details: err instanceof Error ? err.message : String(err),
			}),
			{
				status: 500,
				headers: {
					...getHeaders(origin),
					...CACHE_CONTROL_HEADERS,
				},
			},
		);
	}
}
