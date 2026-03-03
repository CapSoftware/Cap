import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { provideOptionalAuth, Tinybird } from "@cap/web-backend";
import { CurrentUser, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import type { NextRequest } from "next/server";
import UAParser from "ua-parser-js";

import { getAnonymousName } from "@/lib/anonymous-names";
import { createAnonymousViewNotification } from "@/lib/Notification";
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

	const tenantId =
		body.orgId || body.ownerId || (hostname ? `domain:${hostname}` : "public");

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
			if (userId && body.ownerId && userId === body.ownerId) {
				const ownerIdResult = yield* Effect.tryPromise(() =>
					db()
						.select({ ownerId: videos.ownerId })
						.from(videos)
						.where(eq(videos.id, Video.VideoId.make(body.videoId)))
						.limit(1)
						.then((rows) => rows[0]?.ownerId ?? null),
				).pipe(Effect.orElseSucceed(() => null as string | null));
				if (ownerIdResult && userId === ownerIdResult) {
					return;
				}
			}

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

			if (!userId && sessionId) {
				const anonName = getAnonymousName(sessionId);
				const location =
					city && country ? `${city}, ${country}` : city || country || null;

				yield* Effect.forkDaemon(
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
				);
			}
		}).pipe(provideOptionalAuth),
	);

	return Response.json({ success: true });
}
