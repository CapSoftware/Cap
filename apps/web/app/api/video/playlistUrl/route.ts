import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { s3Buckets, videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { CACHE_CONTROL_HEADERS, getHeaders } from "@/utils/helpers";
import { createBucketProvider } from "@/utils/s3";

export const revalidate = 0;

export async function OPTIONS(request: NextRequest) {
	const origin = request.headers.get("origin") as string;

	return new Response(null, {
		status: 200,
		headers: getHeaders(origin),
	});
}

export async function GET(request: NextRequest) {
	const searchParams = request.nextUrl.searchParams;
	const userId = searchParams.get("userId") || "";
	const videoId = searchParams.get("videoId") || "";
	const origin = request.headers.get("origin") as string;

	if (!userId || !videoId) {
		return new Response(
			JSON.stringify({
				error: true,
				message: "userId or videoId not supplied",
			}),
			{
				status: 401,
				headers: getHeaders(origin),
			},
		);
	}

	const query = await db()
		.select({ video: videos, bucket: s3Buckets })
		.from(videos)
		.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
		.where(eq(videos.id, videoId));

	if (query.length === 0) {
		return new Response(
			JSON.stringify({ error: true, message: "Video does not exist" }),
			{
				status: 401,
				headers: getHeaders(origin),
			},
		);
	}

	const result = query[0];
	if (!result?.video) {
		return new Response(
			JSON.stringify({ error: true, message: "Video not found" }),
			{
				status: 404,
				headers: getHeaders(origin),
			},
		);
	}

	const { video, bucket } = result;

	if (video.jobStatus === "COMPLETE") {
		// Enforce access control for non-public videos
		if (video.public === false) {
			const user = await getCurrentUser();
			if (!user || user.id !== video.ownerId) {
				return new Response(
					JSON.stringify({ error: true, message: "Video is not public" }),
					{ status: 401, headers: getHeaders(origin) },
				);
			}
		}

		const bucketProvider = await createBucketProvider(bucket);
		const playlistKey = `${video.ownerId}/${video.id}/output/video_recording_000_output.m3u8`;
		const playlistUrl = await bucketProvider.getSignedObjectUrl(playlistKey);

		return new Response(
			JSON.stringify({ playlistOne: playlistUrl, playlistTwo: null }),
			{
				status: 200,
				headers: {
					...getHeaders(origin),
					...CACHE_CONTROL_HEADERS,
				},
			},
		);
	}

	return new Response(
		JSON.stringify({
			playlistOne: `${serverEnv().WEB_URL}/api/playlist?userId=${
				video.ownerId
			}&videoId=${video.id}&videoType=video`,
			playlistTwo: `${serverEnv().WEB_URL}/api/playlist?userId=${
				video.ownerId
			}&videoId=${video.id}&videoType=audio`,
		}),
		{
			status: 200,
			headers: {
				...getHeaders(origin),
				...CACHE_CONTROL_HEADERS,
			},
		},
	);
}
