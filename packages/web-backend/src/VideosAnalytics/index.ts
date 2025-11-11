import { serverEnv } from "@cap/env";
import { dub } from "@cap/utils";
import { Policy, Video, VideoAnalytics } from "@cap/web-domain";
import {
	FetchHttpClient,
	HttpBody,
	HttpClient,
	HttpClientResponse,
} from "@effect/platform";
import { Effect } from "effect";
import { VideosPolicy } from "../Videos/VideosPolicy";
import { VideosRepo } from "../Videos/VideosRepo";

export class VideosAnalytics extends Effect.Service<VideosAnalytics>()(
	"VideosAnalytics",
	{
		effect: Effect.gen(function* () {
			const repo = yield* VideosRepo;
			const policy = yield* VideosPolicy;
			const client = yield* HttpClient.HttpClient;

			const getByIdForViewing = (id: Video.VideoId) =>
				repo
					.getById(id)
					.pipe(
						Policy.withPublicPolicy(policy.canView(id)),
						Effect.withSpan("VideosAnalytics.getById"),
					);

			return {
				getViewCount: Effect.fn("VideosAnalytics.getViewCount")(function* (
					videoId: Video.VideoId,
				) {
					const [video] = yield* getByIdForViewing(videoId).pipe(
						Effect.flatten,
						Effect.catchTag(
							"NoSuchElementException",
							() => new Video.NotFoundError(),
						),
					);

					console.log("HERE GET");
					const token = serverEnv().TINYBIRD_TOKEN;
					const host = serverEnv().TINYBIRD_HOST;
					if (token && host) {
						const response2 = yield* client.get(
							`${host}/v0/pipes/video_views.json?token=${token}&video_id=${video.id}`,
						);
						if (response2.status !== 200) {
							// TODO
						}
						console.log("ANALYTICS", response2.status, yield* response2.text);

						// TODO: Effect schema
						const result = JSON.parse(yield* response2.text);
						return { count: result.data[0].count };
					}

					const response = yield* Effect.tryPromise(() =>
						dub().analytics.retrieve({
							domain: "cap.link",
							key: video.id,
						}),
					);
					const { clicks } = response as { clicks: unknown };

					if (typeof clicks !== "number" || clicks === null)
						return { count: 0 };

					return { count: clicks };
				}),

				getAnalytics: Effect.fn("VideosAnalytics.getAnalytics")(function* (
					_videoId: Video.VideoId,
				) {
					// TODO: Implement this

					return VideoAnalytics.VideoAnalytics.make({
						views: 0,
					});
				}),

				captureEvent: Effect.fn("VideosAnalytics.captureEvent")(function* (
					event: VideoAnalytics.VideoCaptureEvent,
				) {
					const videoId = event.video;

					const token = serverEnv().TINYBIRD_TOKEN;
					const host = serverEnv().TINYBIRD_HOST;
					if (!token || !host) return;

					const toNullableString = (value?: string | null) =>
						value && value.trim().length > 0 ? value : null;
					const toNullableNumber = (value?: number | null) =>
						typeof value === "number" && Number.isFinite(value) ? value : null;
					const toNullableInt = (value?: number | null) =>
						typeof value === "number" && Number.isFinite(value)
							? Math.trunc(value)
							: null;

					const watchTime = toNullableNumber(event.watchTimeSeconds) ?? 0;

					const serializedPayload = JSON.stringify({
						city: event.city ?? null,
						country: event.country ?? null,
						device: event.device ?? null,
						browser: event.browser ?? null,
						os: event.os ?? null,
						referrer: toNullableString(event.referrer),
						referrerUrl: toNullableString(event.referrerUrl),
						utmSource: toNullableString(event.utmSource),
						utmMedium: toNullableString(event.utmMedium),
						utmCampaign: toNullableString(event.utmCampaign),
						utmTerm: toNullableString(event.utmTerm),
						utmContent: toNullableString(event.utmContent),
						locale: toNullableString(event.locale),
						language: toNullableString(event.language),
						timezone: toNullableString(event.timezone),
						pathname: toNullableString(event.pathname),
						href: toNullableString(event.href),
						userAgent: toNullableString(event.userAgent),
						watchTimeSeconds: watchTime,
					});

					const payload = {
						timestamp: new Date().toISOString(),
						version: "1",
						session_id: toNullableString(event.sessionId),
						video_id: videoId,
						watch_time_seconds: watchTime,
						city: event.city ?? null,
						country: event.country ?? null,
						device: event.device ?? null,
						browser: event.browser ?? null,
						os: event.os ?? null,
						referrer: toNullableString(event.referrer),
						referrer_url: toNullableString(event.referrerUrl),
						utm_source: toNullableString(event.utmSource),
						utm_medium: toNullableString(event.utmMedium),
						utm_campaign: toNullableString(event.utmCampaign),
						utm_term: toNullableString(event.utmTerm),
						utm_content: toNullableString(event.utmContent),
						payload: serializedPayload,
					};

					yield* client
						.post(`${host}/v0/events?name=analytics_views`, {
							body: yield* HttpBody.json(payload),
						headers: {
							Authorization: `Bearer ${token}`,
						},
					});
				}),
			};
		}),
		dependencies: [
			VideosPolicy.Default,
			VideosRepo.Default,
			FetchHttpClient.layer,
		],
	},
) {}
