import { isEmailAllowedByRestriction } from "@cap/utils";
import { Policy, Video } from "@cap/web-domain";
import { Array, Effect, Option } from "effect";

import { Database } from "../Database.ts";
import { OrganisationsRepo } from "../Organisations/OrganisationsRepo.ts";
import { SpacesRepo } from "../Spaces/SpacesRepo.ts";
import { VideosRepo } from "./VideosRepo.ts";

export type VideosPolicyDeps = {
	repo: {
		getById: (
			id: Video.VideoId,
		) => Effect.Effect<
			Option.Option<readonly [Video.Video, Option.Option<string>]>,
			any
		>;
	};
	orgsRepo: {
		membershipForVideo: (
			userId: any,
			videoId: Video.VideoId,
		) => Effect.Effect<readonly { membershipId: string }[], any>;
		allowedEmailDomain: (
			orgId: any,
		) => Effect.Effect<Option.Option<string>, any>;
	};
	spacesRepo: {
		membershipForVideo: (
			userId: any,
			videoId: Video.VideoId,
		) => Effect.Effect<Option.Option<{ membershipId: string }>, any>;
	};
};

export function buildCanView(
	{ repo, orgsRepo, spacesRepo }: VideosPolicyDeps,
	videoId: Video.VideoId,
) {
	return Policy.publicPolicy(
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

				const [videoOrgShareMembership, videoSpaceShareMembership] =
					yield* Effect.all([
						orgsRepo
							.membershipForVideo(userId, video.id)
							.pipe(Effect.map(Array.get(0))),
						spacesRepo.membershipForVideo(userId, video.id),
					]);

				if (
					Option.isSome(videoOrgShareMembership) ||
					Option.isSome(videoSpaceShareMembership)
				) {
					yield* Effect.log(
						"Explicit org/space membership found. Access granted.",
					);
					yield* Video.verifyPassword(video, password);
					return true;
				}
			}

			if (!video.public) {
				yield* Effect.log(
					"Video is private and user has no explicit access. Access denied.",
				);
				return false;
			}

			const allowedEmails = yield* orgsRepo.allowedEmailDomain(video.orgId);
			const restriction = Option.isSome(allowedEmails)
				? allowedEmails.value.trim()
				: "";

			if (restriction.length > 0) {
				if (Option.isNone(user)) {
					yield* Effect.log(
						"Email access restriction active and user not logged in. Access denied.",
					);
					yield* Effect.fail(
						new Policy.PolicyDeniedError({
							reason: "email_restriction_login_required",
						}),
					);
				}
				if (
					Option.isSome(user) &&
					!isEmailAllowedByRestriction(user.value.email, restriction)
				) {
					yield* Effect.log("Email access restriction active. Access denied.");
					yield* Effect.fail(
						new Policy.PolicyDeniedError({
							reason: "email_restriction_denied",
						}),
					);
				}
			}

			yield* Video.verifyPassword(video, password);

			return true;
		}),
	);
}

export class VideosPolicy extends Effect.Service<VideosPolicy>()(
	"VideosPolicy",
	{
		effect: Effect.gen(function* () {
			const repo = yield* VideosRepo;
			const orgsRepo = yield* OrganisationsRepo;
			const spacesRepo = yield* SpacesRepo;

			const deps: VideosPolicyDeps = { repo, orgsRepo, spacesRepo };

			const canView = (videoId: Video.VideoId) => buildCanView(deps, videoId);

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
			Database.Default,
		],
	},
) {}
