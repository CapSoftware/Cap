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

					const payload = {
						timestamp: new Date().toISOString(),
						version: "1",
						session_id: event.sessionId ?? null,
						video_id: videoId,
						watch_time_seconds: event.watchTimeSeconds ?? 0,
						city: event.city ?? null,
						country: event.country ?? null,
						device: event.device ?? null,
						browser: event.browser ?? null,
						os: event.os ?? null,
						referrer: event.referrer ?? null,
						referrer_url: event.referrerUrl ?? null,
						utm_source: event.utmSource ?? null,
						utm_medium: event.utmMedium ?? null,
						utm_campaign: event.utmCampaign ?? null,
						utm_term: event.utmTerm ?? null,
						utm_content: event.utmContent ?? null,
						payload: JSON.stringify({
							watchTimeSeconds: event.watchTimeSeconds ?? 0,
							city: event.city ?? null,
							country: event.country ?? null,
							device: event.device ?? null,
							browser: event.browser ?? null,
							os: event.os ?? null,
							referrer: event.referrer ?? null,
							referrerUrl: event.referrerUrl ?? null,
							utmSource: event.utmSource ?? null,
							utmMedium: event.utmMedium ?? null,
							utmCampaign: event.utmCampaign ?? null,
							utmTerm: event.utmTerm ?? null,
							utmContent: event.utmContent ?? null,
						}),
					};

					console.log("TINYBIRD EVENT", payload);

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
