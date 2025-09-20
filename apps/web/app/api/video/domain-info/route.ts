import { db } from "@cap/database";
import { organizations, sharedVideos, videos } from "@cap/database/schema";
import { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
	const { searchParams } = request.nextUrl;
	const videoId = searchParams.get("videoId");

	if (!videoId) {
		return Response.json({ error: "Video ID is required" }, { status: 400 });
	}

	try {
		// First, get the video to find the owner or shared space
		const [video] = await db()
			.select({
				id: videos.id,
				ownerId: videos.ownerId,
			})
			.from(videos)
			.where(eq(videos.id, Video.VideoId.make(videoId)))
			.limit(1);

		if (!video) {
			return Response.json({ error: "Video not found" }, { status: 404 });
		}

		if (!video.ownerId) {
			return Response.json({ error: "Invalid video data" }, { status: 500 });
		}

		// Check if the video is shared with a space
		const sharedVideo = await db()
			.select({
				organizationId: sharedVideos.organizationId,
			})
			.from(sharedVideos)
			.where(eq(sharedVideos.videoId, Video.VideoId.make(videoId)))
			.limit(1);

		let organizationId = null;
		if (
			sharedVideo.length > 0 &&
			sharedVideo[0] &&
			sharedVideo[0].organizationId
		) {
			organizationId = sharedVideo[0].organizationId;
		}

		if (organizationId) {
			const organization = await db()
				.select({
					customDomain: organizations.customDomain,
					domainVerified: organizations.domainVerified,
				})
				.from(organizations)
				.where(eq(organizations.id, organizationId))
				.limit(1);

			if (
				organization.length > 0 &&
				organization[0] &&
				organization[0].customDomain
			) {
				return Response.json({
					customDomain: organization[0].customDomain,
					domainVerified: organization[0].domainVerified || false,
				});
			}
		}

		const ownerOrganizations = await db()
			.select({
				customDomain: organizations.customDomain,
				domainVerified: organizations.domainVerified,
			})
			.from(organizations)
			.where(eq(organizations.ownerId, video.ownerId))
			.limit(1);

		if (
			ownerOrganizations.length > 0 &&
			ownerOrganizations[0] &&
			ownerOrganizations[0].customDomain
		) {
			return Response.json({
				customDomain: ownerOrganizations[0].customDomain,
				domainVerified: ownerOrganizations[0].domainVerified || false,
			});
		}

		return Response.json({
			customDomain: null,
			domainVerified: false,
		});
	} catch (error) {
		console.error("Error fetching domain info:", error);
		return Response.json({ error: "Internal server error" }, { status: 500 });
	}
}
