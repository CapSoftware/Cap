import { Policy, Video } from "@cap/web-domain";
import { Effect, Option } from "effect";

import { OrganisationsRepo } from "../Organisations/OrganisationsRepo";
import { SpacesRepo } from "../Spaces/SpacesRepo";
import { VideosRepo } from "./VideosRepo";

export class VideosPolicy extends Effect.Service<VideosPolicy>()(
	"VideosPolicy",
	{
		effect: Effect.gen(function* () {
			const repo = yield* VideosRepo;
			const orgsRepo = yield* OrganisationsRepo;
			const spacesRepo = yield* SpacesRepo;

			const canView = (videoId: Video.VideoId) =>
				Policy.publicPolicy(
					Effect.fn(function* (user) {
						const res = yield* repo.getById(videoId);

						if (Option.isNone(res)) return true;

						const [video, password] = res.value;

						if (Option.isSome(user)) {
							const userId = user.value.id;
							if (userId === video.ownerId) return true;

							if (!video.public) {
								const [videoOrgShareMembership, videoSpaceShareMembership] =
									yield* Effect.all([
										orgsRepo.membershipForVideo(userId, video.id),
										spacesRepo.membershipForVideo(userId, video.id),
									]);

								if (!videoSpaceShareMembership || !videoOrgShareMembership)
									return false;
							}
						} else {
							if (!video.public) return false;
						}

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
		dependencies: [VideosRepo.Default, OrganisationsRepo.Default, SpacesRepo.Default],
	},
) { }
