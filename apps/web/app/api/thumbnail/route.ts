import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { Storage } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";
import { getHeaders } from "@/utils/helpers";

export async function GET(request: NextRequest) {
	const { searchParams } = request.nextUrl;
	const videoId = searchParams.get("videoId");
	const origin = request.headers.get("origin") as string;

	if (!videoId)
		return new Response(
			JSON.stringify({
				error: true,
				message: "userId or videoId not supplied",
			}),
			{
				status: 400,
				headers: getHeaders(origin),
			},
		);

	const [query] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, Video.VideoId.make(videoId)));

	if (!query)
		return new Response(
			JSON.stringify({ error: true, message: "Video not found" }),
			{
				status: 404,
				headers: getHeaders(origin),
			},
		);

	const video = decodeStorageVideo(query);

	const prefix = `${video.ownerId}/${video.id}/`;

	try {
		const [bucket] = await Storage.getAccessForVideo(video).pipe(runPromise);

		const listResponse = await bucket
			.listObjects({ prefix: prefix })
			.pipe(runPromise);
		const contents = listResponse.Contents || [];

		const thumbnailKey = contents.find((item) =>
			item.Key?.endsWith("screen-capture.jpg"),
		)?.Key;

		if (!thumbnailKey)
			return new Response(
				JSON.stringify({
					error: true,
					message: "No thumbnail found for this video",
				}),
				{
					status: 404,
					headers: getHeaders(origin),
				},
			);

		const thumbnailUrl = await bucket
			.getSignedObjectUrl(thumbnailKey)
			.pipe(runPromise);

		return new Response(JSON.stringify({ screen: thumbnailUrl }), {
			status: 200,
			headers: getHeaders(origin),
		});
	} catch (error) {
		return new Response(
			JSON.stringify({
				error: true,
				message: "Error generating thumbnail URL",
				details: error instanceof Error ? error.message : "Unknown error",
			}),
			{
				status: 500,
				headers: getHeaders(origin),
			},
		);
	}
}
