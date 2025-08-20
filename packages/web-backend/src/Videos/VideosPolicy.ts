import { Policy, Video } from "@cap/web-domain";
import { Array, Effect, Option } from "effect";

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

						if (Option.isNone(res)) {
							yield* Effect.log("Video not found. Access granted.");
							return true;
						}

						const [video, password] = res.value;

						if (Option.isSome(user)) {
							const userId = user.value.id;
							if (userId === video.ownerId) return true;

							if (!video.public) {
								const [videoOrgShareMembership, videoSpaceShareMembership] =
									yield* Effect.all([
										orgsRepo
											.membershipForVideo(userId, video.id)
											.pipe(Effect.map(Array.get(0))),
										spacesRepo
											.membershipForVideo(userId, video.id)
											.pipe(Effect.map(Array.get(0))),
									]);

								if (
									Option.isNone(videoOrgShareMembership) &&
									Option.isNone(videoSpaceShareMembership)
								) {
									yield* Effect.log(
										"Neither org nor space sharing found. Access denied.",
									);
									return false;
								}

								if (Option.isSome(videoOrgShareMembership)) {
									yield* Effect.log("Org sharing found.");
								}

								if (Option.isSome(videoSpaceShareMembership)) {
									yield* Effect.log("Space sharing found.");
								}
							}
						} else {
							if (!video.public) {
								yield* Effect.log(
									"Video is private and user is not logged in. Access denied.",
								);
								return false;
							}
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
		dependencies: [
			VideosRepo.Default,
			OrganisationsRepo.Default,
			SpacesRepo.Default,
		],
	},
) {}
