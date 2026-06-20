import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import { provideOptionalAuth, Tinybird } from "@cap/web-backend";
import { CurrentUser, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import type { NextRequest } from "next/server";
import UAParser from "ua-parser-js";

import { getAnonymousName } from "@/lib/anonymous-names";
import {
	createAnonymousViewNotification,
	sendFirstViewEmail,
} from "@/lib/Notification";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";
import { runPromise } from "@/lib/server";

interface TrackPayload {
	videoId: string;
	orgId?: string | null;
	ownerId?: string | null;
	sessionId?: string;
	pathname?: string;
	hostname?: string | null;
	userAgent?: string;
	occurredAt?: string;
}

const VIEW_TRACKING_DELAY_MS = 2 * 60 * 1000;

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
	let body: TrackPayload;
	try {
		body = (await request.json()) as TrackPayload;
	} catch (_error) {
		return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
	}

	if (!body?.videoId) {
		return Response.json({ error: "videoId is required" }, { status: 400 });
	}

	if (await isRateLimited(RATE_LIMIT_IDS.ANALYTICS_TRACK)) {
		return Response.json({ error: "Too many requests" }, { status: 429 });
	}

	const parsedSessionId =
		typeof body.sessionId === "string"
			? body.sessionId.trim().slice(0, 128) || null
			: null;
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

	const timestamp = body.occurredAt ? new Date(body.occurredAt) : new Date();

	const country =
		sanitizeString(request.headers.get("x-vercel-ip-country")) || "";
	const region =
		sanitizeString(request.headers.get("x-vercel-ip-country-region")) || "";
	const city =
		sanitizeString(
			decodeUrlEncodedHeaderValue(request.headers.get("x-vercel-ip-city")),
		) || "";

	const hostname =
		sanitizeString(body.hostname) ||
		sanitizeString(request.nextUrl.hostname) ||
		"";

	const pathname = body.pathname ?? `/s/${body.videoId}`;

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
						ownerId: videos.ownerId,
						orgId: videos.orgId,
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
			).pipe(
				Effect.orElseSucceed(
					() =>
						[] as {
							ownerId: string;
							orgId: string | null;
							firstViewEmailSentAt: Date | null;
							videoName: string;
							createdAt: Date;
							updatedAt: Date;
							activeUploadVideoId: string | null;
						}[],
				),
			);

			if (videoRecord && userId === videoRecord.ownerId) {
				return;
			}

			if (
				videoRecord &&
				(videoRecord.activeUploadVideoId ||
					Date.now() - videoRecord.updatedAt.getTime() < VIEW_TRACKING_DELAY_MS)
			) {
				return;
			}

			// Derive the tenant strictly from the looked-up video record so a
			// caller cannot spoof another tenant's analytics via body.orgId /
			// body.ownerId. Prefer the video's org id (what every analytics reader
			// filters tenant_id by), then fall back to per-owner scoping, and only
			// to host/public when the video is unknown.
			const tenantId =
				videoRecord?.orgId ??
				videoRecord?.ownerId ??
				(hostname ? `domain:${hostname}` : "public");

			const tinybird = yield* Tinybird;
			yield* tinybird.appendEvents([
				{
					timestamp: timestamp.toISOString(),
					session_id: sessionId ?? "anon",
					action: "page_hit",
					version: "1.0",
					tenant_id: tenantId,
					video_id: body.videoId,
					pathname,
					country,
					region,
					city,
					browser: browserName,
					device: deviceType,
					os: osName,
					user_id: userId,
				},
			]);

			const isNewVideo =
				videoRecord && videoRecord.createdAt >= ANON_NOTIF_CUTOFF;
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
		}).pipe(provideOptionalAuth),
	);

	return Response.json({ success: true });
}
