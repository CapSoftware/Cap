import { serverEnv } from "@cap/env";
import { dub } from "@cap/utils";
import { Policy, Video, VideoAnalytics } from "@cap/web-domain";
import { FetchHttpClient, HttpBody, HttpClient } from "@effect/platform";
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
					videoId: Video.VideoId,
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

					console.log("TINYBIRD EVENT"); // TODO
					const response = yield* client.post(
						`${host}/v0/events?name=analytics_views`,
						{
							body: HttpBody.unsafeJson({
								timestamp: new Date().toISOString(),
								version: "1",
								session_id: "todo", // TODO
								video_id: videoId,
								payload: JSON.stringify({
									hello: "world", // TODO
								}),
							}),
							headers: {
								Authorization: `Bearer ${token}`,
							},
						},
					);
					// const response = yield* HttpClientResponse.filterStatusOk(response);
					if (response.status !== 200) {
						// TODO
					}

					console.log(response.status, yield* response.text);
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
