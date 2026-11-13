import { db } from "@cap/database";
import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { videos, videoUploads } from "@cap/database/schema";
import { provideOptionalAuth, Tinybird, VideosPolicy } from "@cap/web-backend";
import { CurrentUser, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import type { NextRequest } from "next/server";
import UAParser from "ua-parser-js";
import { z } from "zod";

import { getAnonymousName } from "@/lib/anonymous-names";
import { getClientIp } from "@/lib/client-ip";
import {
	createAnonymousViewNotification,
	sendFirstViewEmail,
} from "@/lib/Notification";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";
import { runPromise } from "@/lib/server";
import { geoIpLocation } from "@/lib/visitor-location";

const trackPayloadSchema = z.object({
	videoId: z.string().min(1).max(64),
	sessionId: z.string().max(128).optional(),
	userAgent: z.string().max(4096).optional(),
	occurredAt: z.string().max(64).optional(),
});

const VIEW_TRACKING_DELAY_MS = 2 * 60 * 1000;
const MAX_CLIENT_CLOCK_SKEW_MS = 5 * 60 * 1000;

const viewTimestamp = (occurredAt: unknown, now: number) => {
	const time =
		typeof occurredAt === "string" ? Date.parse(occurredAt) : Number.NaN;
	return Number.isFinite(time) &&
		Math.abs(time - now) <= MAX_CLIENT_CLOCK_SKEW_MS
		? new Date(time)
		: new Date(now);
};

const sanitizeString = (value?: string | null) => {
	const trimmed = value?.trim();
	return trimmed && trimmed !== "unknown" ? trimmed.slice(0, 256) : undefined;
};

const decodeUrlEncodedHeaderValue = (value?: string | null) => {
	if (!value) return value;
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
};

export async function POST(request: NextRequest) {
	if (
		await isRateLimited(RATE_LIMIT_IDS.ANALYTICS_TRACK, {
			headers: request.headers,
		})
	) {
		return Response.json({ error: "Too many requests" }, { status: 429 });
	}

	let rawBody: unknown;
	try {
		rawBody = await request.json();
	} catch (_error) {
		return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
	}

	const parsedBody = trackPayloadSchema.safeParse(rawBody);
	if (!parsedBody.success) {
		return Response.json({ error: "Invalid payload" }, { status: 400 });
	}
	const body = parsedBody.data;

	const parsedSessionId = body.sessionId?.trim() || null;
	const sessionId =
		parsedSessionId && parsedSessionId !== "anonymous" ? parsedSessionId : null;
	const userAgent =
		sanitizeString(request.headers.get("user-agent")) ||
		sanitizeString(body.userAgent) ||
		"unknown";
	const parser = new UAParser(userAgent);
	const browserName = parser.getBrowser().name ?? "unknown";
	const osName = parser.getOS().name ?? "unknown";
	const deviceType = parser.getDevice().type ?? "desktop";

	const timestamp = viewTimestamp(body.occurredAt, Date.now());

	let country =
		sanitizeString(request.headers.get("x-vercel-ip-country")) || "";
	let region =
		sanitizeString(request.headers.get("x-vercel-ip-country-region")) || "";
	let city =
		sanitizeString(
			decodeUrlEncodedHeaderValue(request.headers.get("x-vercel-ip-city")),
		) || "";
	if (!country) {
		const location = geoIpLocation(
			getClientIp((name) => request.headers.get(name)),
		);
		if (location) ({ country, region, city } = location);
	}

	await runPromise(
		Effect.gen(function* () {
			const maybeUser = yield* Effect.serviceOption(CurrentUser);
			const userId = Option.match(maybeUser, {
				onNone: () => null as string | null,
				onSome: (user) => {
					const currentUser = user as {
						id: string;
						email: string;
						activeOrganizationId: string;
						iconUrlOrKey: Option.Option<unknown>;
					};
					return currentUser.id;
				},
			});

			const ANON_NOTIF_CUTOFF = new Date("2026-03-04T00:00:00Z");

			const [videoRecord] = yield* Effect.tryPromise(() =>
				db()
					.select({
						id: videos.id,
						orgId: videos.orgId,
						ownerId: videos.ownerId,
						public: videos.public,
						password: videos.password,
						firstViewEmailSentAt: videos.firstViewEmailSentAt,
						videoName: videos.name,
						createdAt: videos.createdAt,
						updatedAt: videos.updatedAt,
						activeUploadVideoId: videoUploads.videoId,
					})
					.from(videos)
					.leftJoin(videoUploads, eq(videoUploads.videoId, videos.id))
					.where(eq(videos.id, Video.VideoId.make(body.videoId)))
					.limit(1),
			).pipe(Effect.orElseSucceed(() => []));

			if (!videoRecord || userId === videoRecord.ownerId) {
				return;
			}

			if (
				videoRecord.activeUploadVideoId ||
				Date.now() - videoRecord.updatedAt.getTime() < VIEW_TRACKING_DELAY_MS
			) {
				return;
			}

			const videosPolicy = yield* VideosPolicy;
			const canView = yield* videosPolicy
				.canViewLoaded(videoRecord, Option.fromNullable(videoRecord.password))
				.pipe(
					Effect.as(true),
					Effect.orElseSucceed(() => false),
				);
			if (!canView) return;

			const tinybird = yield* Tinybird;
			yield* tinybird.appendEvents([
				{
					timestamp: timestamp.toISOString(),
					session_id: sessionId ?? "anon",
					action: "page_hit",
					version: "1.0",
					tenant_id: videoRecord.orgId || videoRecord.ownerId,
					video_id: body.videoId,
					pathname: `/s/${body.videoId}`,
					country,
					region,
					city,
					browser: browserName,
					device: deviceType,
					os: osName,
					user_id: userId,
				},
			]);

			const isNewVideo = videoRecord.createdAt >= ANON_NOTIF_CUTOFF;
			const shouldSendFirstViewEmail =
				isNewVideo && !videoRecord.firstViewEmailSentAt;

			if (userId) {
				if (shouldSendFirstViewEmail) {
					yield* Effect.forkDaemon(
						Effect.tryPromise(() =>
							sendFirstViewEmail({
								videoId: body.videoId,
								viewerUserId: userId,
								isAnonymous: false,
							}),
						).pipe(
							Effect.catchAll((error) => {
								console.error("Failed to send first view email:", error);
								return Effect.void;
							}),
						),
					);
				}
			}

			if (!userId && sessionId && isNewVideo) {
				const anonName = getAnonymousName(sessionId);
				const location =
					city && country ? `${city}, ${country}` : city || country || null;

				const effects: Effect.Effect<void, never, never>[] = [
					Effect.tryPromise(() =>
						createAnonymousViewNotification({
							videoId: body.videoId,
							sessionId,
							anonName,
							location,
						}),
					).pipe(
						Effect.catchAll((error) => {
							console.error(
								"Failed to create anonymous view notification:",
								error,
							);
							return Effect.void;
						}),
					),
				];

				if (shouldSendFirstViewEmail) {
					effects.push(
						Effect.tryPromise(() =>
							sendFirstViewEmail({
								videoId: body.videoId,
								viewerName: anonName,
								isAnonymous: true,
							}),
						).pipe(
							Effect.catchAll((error) => {
								console.error("Failed to send first view email:", error);
								return Effect.void;
							}),
						),
					);
				}

				yield* Effect.forkDaemon(Effect.all(effects));
			}

			if (!userId && !sessionId && isNewVideo && shouldSendFirstViewEmail) {
				yield* Effect.forkDaemon(
					Effect.tryPromise(() =>
						sendFirstViewEmail({
							videoId: body.videoId,
							viewerName: "Anonymous Viewer",
							isAnonymous: true,
						}),
					).pipe(
						Effect.catchAll((error) => {
							console.error("Failed to send first view email:", error);
							return Effect.void;
						}),
					),
				);
			}
		}).pipe((trackView) =>
			isCrossSiteCookieWrite(request)
				? trackView
				: provideOptionalAuth(trackView),
		),
	);

	return Response.json({ success: true });
}
