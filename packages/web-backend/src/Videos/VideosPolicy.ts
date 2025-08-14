import { Policy, Video } from "@cap/web-domain";
import { Effect, Option } from "effect";

import { VideosRepo } from "./VideosRepo";

export class VideosPolicy extends Effect.Service<VideosPolicy>()(
	"VideosPolicy",
	{
		effect: Effect.gen(function* () {
			const repo = yield* VideosRepo;

			const canView = (videoId: Video.VideoId) =>
				Policy.publicPolicy(
					Effect.fn(function* (user) {
						const res = yield* repo.getById(videoId);

						if (Option.isNone(res)) return true;

						const [video, password] = res.value;

						if (
							user.pipe(
								Option.filter((user) => user.id === video.ownerId),
								Option.isSome,
							)
						)
							return true;

						yield* Video.verifyPassword(video, password);

						return true;
					}),
				);

			const isOwner = (videoId: Video.VideoId) =>
				Policy.policy((user) =>
					repo.getById(videoId).pipe(
						Effect.map(
							Option.match({
								onNone: () => true,
								onSome: ([video]) => video.ownerId === user.id,
							}),
						),
					),
				);

			return { canView, isOwner };
		}),
		dependencies: [VideosRepo.Default],
	},
) {}
