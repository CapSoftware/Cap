import { isEmailAllowedByRestriction } from "@cap/utils";
import {
	type CurrentUser,
	type DatabaseError,
	type Organisation,
	Policy,
	type User,
	Video,
} from "@cap/web-domain";
import { Array, Effect, Option } from "effect";

import { Database } from "../Database.ts";
import { OrganisationsRepo } from "../Organisations/OrganisationsRepo.ts";
import { SpacesRepo } from "../Spaces/SpacesRepo.ts";
import { collectPasswordHashes } from "./EffectiveVideoRules.ts";
import { VideosRepo } from "./VideosRepo.ts";

export type LoadedVideo = readonly [Video.Video, Option.Option<string>];

export type ViewableVideo = Pick<
	Video.Video,
	"id" | "ownerId" | "orgId" | "public"
>;

export type VideosPolicyDeps = {
	repo: {
		getById: (
			id: Video.VideoId,
		) => Effect.Effect<Option.Option<LoadedVideo>, DatabaseError>;
	};
	orgsRepo: {
		membershipForVideo: (
			userId: User.UserId,
			videoId: Video.VideoId,
		) => Effect.Effect<readonly { membershipId: string }[], DatabaseError>;
		allowedEmailDomain: (
			orgId: Organisation.OrganisationId,
		) => Effect.Effect<Option.Option<string>, DatabaseError>;
	};
	spacesRepo: {
		membershipForVideo: (
			userId: User.UserId,
			videoId: Video.VideoId,
		) => Effect.Effect<Option.Option<{ membershipId: string }>, DatabaseError>;
		passwordsForVideo: (
			videoId: Video.VideoId,
		) => Effect.Effect<readonly { password: string | null }[], DatabaseError>;
	};
};

export type ViewDecisionDeps = Pick<
	VideosPolicyDeps,
	"orgsRepo" | "spacesRepo"
>;

const decideCanView = (
	{ orgsRepo, spacesRepo }: ViewDecisionDeps,
	user: Option.Option<CurrentUser["Type"]>,
	video: ViewableVideo,
	password: Option.Option<string>,
) =>
	Effect.gen(function* () {
		if (Option.isSome(user)) {
			const userId = user.value.id;
			if (userId === video.ownerId) return true;
		}

		const spacePasswords = yield* spacesRepo.passwordsForVideo(video.id);
		const passwordHashes = collectPasswordHashes({
			videoPassword: Option.getOrNull(password),
			spacePasswords: [...spacePasswords],
		});

		if (Option.isSome(user)) {
			const userId = user.value.id;
			const [videoOrgShareMembership, videoSpaceShareMembership] =
				yield* Effect.all(
					[
						orgsRepo
							.membershipForVideo(userId, video.id)
							.pipe(Effect.map(Array.get(0))),
						spacesRepo.membershipForVideo(userId, video.id),
					],
					{ concurrency: "unbounded" },
				);

			if (
				Option.isSome(videoOrgShareMembership) ||
				Option.isSome(videoSpaceShareMembership)
			) {
				yield* Effect.log(
					"Explicit org/space membership found. Access granted.",
				);
				yield* Video.verifyPasswordCandidates(video, passwordHashes);
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

		yield* Video.verifyPasswordCandidates(video, passwordHashes);

		return true;
	});

export function buildCanView(deps: VideosPolicyDeps, videoId: Video.VideoId) {
	return Policy.publicPolicy(
		Effect.fn(function* (user) {
			const res = yield* deps.repo.getById(videoId);

			if (Option.isNone(res)) {
				yield* Effect.log("Video not found. Access granted.");
				return true;
			}

			const [video, password] = res.value;
			return yield* decideCanView(deps, user, video, password);
		}),
	);
}

export function buildCanViewLoaded(
	deps: ViewDecisionDeps,
	video: ViewableVideo,
	password: Option.Option<string>,
) {
	return Policy.publicPolicy((user) =>
		decideCanView(deps, user, video, password),
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

			const canViewLoaded = (
				video: ViewableVideo,
				password: Option.Option<string>,
			) => buildCanViewLoaded(deps, video, password);

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

			const isOwnerLoaded = (video: Pick<Video.Video, "ownerId">) =>
				Policy.policy((user) => Effect.succeed(video.ownerId === user.id));

			const getViewableById = (videoId: Video.VideoId) =>
				repo.getById(videoId).pipe(
					Effect.flatMap(
						Option.match({
							onNone: () => Effect.succeed(Option.none<LoadedVideo>()),
							onSome: (loaded) =>
								canViewLoaded(loaded[0], loaded[1]).pipe(
									Effect.as(Option.some(loaded)),
								),
						}),
					),
				);

			const getOwnedById = (videoId: Video.VideoId) =>
				repo.getById(videoId).pipe(
					Effect.flatMap(
						Option.match({
							onNone: () => Effect.succeed(Option.none<LoadedVideo>()),
							onSome: (loaded) =>
								isOwnerLoaded(loaded[0]).pipe(Effect.as(Option.some(loaded))),
						}),
					),
				);

			return {
				canView,
				canViewLoaded,
				isOwner,
				isOwnerLoaded,
				getViewableById,
				getOwnedById,
			};
		}),
		dependencies: [
			VideosRepo.Default,
			OrganisationsRepo.Default,
			SpacesRepo.Default,
			Database.Default,
		],
	},
) {}
