import { provideOptionalAuth, Tinybird } from "@cap/web-backend";
import { CurrentUser } from "@cap/web-domain";
import { Effect, Option } from "effect";
import type { NextRequest } from "next/server";
import UAParser from "ua-parser-js";

import { getAnonymousName } from "@/lib/anonymous-names";
import { createAnonymousViewNotification } from "@/lib/Notification";
import { runPromise } from "@/lib/server";

const anonNotifRateLimit = new Map<
	string,
	{ count: number; resetAt: number }
>();
const ANON_NOTIF_WINDOW_MS = 5 * 60 * 1000;
const ANON_NOTIF_MAX_PER_VIDEO = 50;
const ANON_NOTIF_MAX_ENTRIES = 10_000;
let anonNotifCleanupCounter = 0;

function checkAnonNotifRateLimit(videoId: string): boolean {
	anonNotifCleanupCounter++;
	if (anonNotifCleanupCounter % 100 === 0) {
		const now = Date.now();
		for (const [k, v] of anonNotifRateLimit) {
			if (v.resetAt < now) anonNotifRateLimit.delete(k);
		}
		if (anonNotifRateLimit.size > ANON_NOTIF_MAX_ENTRIES)
			anonNotifRateLimit.clear();
	}

	const now = Date.now();
	const entry = anonNotifRateLimit.get(videoId);
	if (!entry || entry.resetAt < now) {
		anonNotifRateLimit.set(videoId, {
			count: 1,
			resetAt: now + ANON_NOTIF_WINDOW_MS,
		});
		return true;
	}
	if (entry.count >= ANON_NOTIF_MAX_PER_VIDEO) return false;
	entry.count++;
	return true;
}

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

const sanitizeString = (value?: string | null) =>
	value?.trim() && value.trim() !== "unknown"
		? value.trim().slice(0, 256)
		: undefined;

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

	const sessionId = body.sessionId?.slice(0, 128) ?? "anon";
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
	const city = sanitizeString(request.headers.get("x-vercel-ip-city")) || "";

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
				return;
			}

			const tinybird = yield* Tinybird;
			yield* tinybird.appendEvents([
				{
					timestamp: timestamp.toISOString(),
					session_id: sessionId,
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

			if (
				!userId &&
				sessionId !== "anon" &&
				checkAnonNotifRateLimit(body.videoId)
			) {
				const anonName = getAnonymousName(sessionId);
				const locationParts = [city, country].filter(Boolean);
				const location =
					locationParts.length > 0 ? locationParts.join(", ") : null;

				yield* Effect.tryPromise(() =>
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
				);
			}
		}).pipe(provideOptionalAuth),
	);

	return Response.json({ success: true });
}
