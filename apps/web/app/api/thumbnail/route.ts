import { db } from "@inflight/database";
import { s3Buckets, videos } from "@inflight/database/schema";
import { S3Buckets } from "@inflight/web-backend";
import { Video } from "@inflight/web-domain";
import { eq } from "drizzle-orm";
import { Option } from "effect";
import type { NextRequest } from "next/server";
import { runPromise } from "@/lib/server";
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
		.select({
			video: videos,
			bucket: s3Buckets,
		})
		.from(videos)
		.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
		.where(eq(videos.id, Video.VideoId.make(videoId)));

	if (!query)
		return new Response(
			JSON.stringify({ error: true, message: "Video not found" }),
			{
				status: 404,
				headers: getHeaders(origin),
			},
		);

	const prefix = `${query.video.ownerId}/${query.video.id}/`;

	try {
		const [bucket] = await S3Buckets.getBucketAccess(
			Option.fromNullable(query.bucket?.id),
		).pipe(runPromise);

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
