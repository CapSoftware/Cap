import { db } from "@cap/database";
import {
	importedVideos,
	organizations,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { buildEnv, serverEnv } from "@cap/env";
import { getPublishedRecordingOutputKey } from "@cap/web-backend/src/Storage/recording-output";
import { type Organisation, type User, Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";

// Clients stop at the cap and then finalize, and encoders round, so honest
// recordings can land slightly past the limit.
export const FREE_PLAN_DURATION_GRACE_SECONDS = 30;

export const FREE_PLAN_MAX_MEASURED_SECONDS =
	Video.FREE_PLAN_MAX_RECORDING_SECONDS + FREE_PLAN_DURATION_GRACE_SECONDS;

// Content uploaded before this date is never held by the limit, so
// reprocessing an older upload cannot hold it.
export const FREE_PLAN_MEASURED_DURATION_ENFORCED_FROM = new Date(
	"2026-11-23T00:00:00.000Z",
);

export const FREE_PLAN_DURATION_ERROR_PREFIX =
	Video.FREE_PLAN_DURATION_ERROR_PREFIX;

export const freePlanDurationExceededMessage =
	"Recording exceeds the free plan duration limit. Upgrade to Cap Pro to upload longer recordings.";

export const freePlanDurationExceededError = `${FREE_PLAN_DURATION_ERROR_PREFIX}: ${freePlanDurationExceededMessage}`;

export const FREE_PLAN_DURATION_WEBHOOK_PARAM = "freePlanLimit";

// The media server refuses a source longer than the requested output limit
// with this prefix before encoding it.
export const MEDIA_LENGTH_LIMIT_ERROR_PREFIX = "media-length-limit-exceeded";

export function isFreePlanDurationError(
	error: string | null | undefined,
): error is string {
	return Boolean(error?.startsWith(`${FREE_PLAN_DURATION_ERROR_PREFIX}:`));
}

type PlanUser = {
	stripeSubscriptionStatus?: string | null;
	thirdPartyStripeSubscriptionId?: string | null;
};

// Workflow bundles cannot import @cap/utils, so this mirrors its userIsPro.
export function hasProPlan(user: PlanUser | null | undefined): boolean {
	if (!buildEnv.NEXT_PUBLIC_IS_CAP) return true;
	if (!user) return false;
	if (user.thirdPartyStripeSubscriptionId) return true;
	return (
		user.stripeSubscriptionStatus === "active" ||
		user.stripeSubscriptionStatus === "trialing" ||
		user.stripeSubscriptionStatus === "complete" ||
		user.stripeSubscriptionStatus === "paid" ||
		user.stripeSubscriptionStatus === "past_due"
	);
}

const positiveSeconds = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: null;

// The probe reports the header length as `duration` and the length its
// timestamps actually span as `timestampSpan`. A header can understate how
// long a file plays, so the longer of the two is the measured length.
export function measuredMediaSeconds(
	metadata: { duration?: unknown; timestampSpan?: unknown } | null | undefined,
): number | null {
	const duration = positiveSeconds(metadata?.duration);
	const span = positiveSeconds(metadata?.timestampSpan);
	if (duration === null) return span;
	if (span === null) return duration;
	return Math.max(duration, span);
}

export function exceedsFreePlanMeasuredDuration(
	seconds: number | null,
): boolean {
	return seconds !== null && seconds > FREE_PLAN_MAX_MEASURED_SECONDS;
}

export async function ownerOrOrganizationHasPro(
	ownerId: User.UserId,
	orgId: Organisation.OrganisationId,
): Promise<boolean> {
	const [owner] = await db()
		.select({
			stripeSubscriptionStatus: users.stripeSubscriptionStatus,
			thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
		})
		.from(users)
		.where(eq(users.id, ownerId))
		.limit(1);
	if (hasProPlan(owner)) return true;

	const [organizationOwner] = await db()
		.select({
			stripeSubscriptionStatus: users.stripeSubscriptionStatus,
			thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
		})
		.from(organizations)
		.innerJoin(users, eq(organizations.ownerId, users.id))
		.where(eq(organizations.id, orgId))
		.limit(1);
	return hasProPlan(organizationOwner);
}

export async function getFreePlanRecordingLimit(
	ownerId: User.UserId,
	orgId: Organisation.OrganisationId,
): Promise<number | null> {
	if (!buildEnv.NEXT_PUBLIC_IS_CAP) return null;
	if (await ownerOrOrganizationHasPro(ownerId, orgId)) return null;
	return Video.FREE_PLAN_MAX_RECORDING_SECONDS;
}

// Whether the recording limit the desktop was given for one of the user's
// recordings still applies, so an upgrade of its owner or organization during
// the recording lifts it. Undefined for a recording that isn't the user's.
export async function recordingLimitStillApplies(
	userId: User.UserId,
	videoId: string,
): Promise<boolean | undefined> {
	const [video] = await db()
		.select({ ownerId: videos.ownerId, orgId: videos.orgId })
		.from(videos)
		.where(
			and(
				eq(videos.id, Video.VideoId.make(videoId)),
				eq(videos.ownerId, userId),
			),
		)
		.limit(1);
	if (!video) return undefined;
	return (await getFreePlanRecordingLimit(video.ownerId, video.orgId)) !== null;
}

// Recordings published by the desktop recording pipeline are only held once
// the desktop release that stops free recordings at the limit is out, and
// never ones made before it. Anything else, including other desktop uploads,
// is held as soon as it is measured.
export function desktopLimitAppliesTo(video: {
	id: string;
	ownerId: string;
	source: { type: string; outputKey?: string };
	createdAt: Date;
}): boolean {
	const fromRecordingPipeline =
		video.source.type === "desktopSegments" ||
		(video.source.type === "desktopMP4" &&
			getPublishedRecordingOutputKey(video) !== undefined);
	if (!fromRecordingPipeline) return true;
	const from = serverEnv().CAP_FREE_PLAN_DESKTOP_LIMIT_FROM;
	return from !== undefined && video.createdAt >= new Date(from);
}

// An upload started on or after this date is new content, even for an
// older video.
async function hasUploadSince(
	videoId: Video.VideoId,
	since: Date,
): Promise<boolean> {
	const [upload] = await db()
		.select({ startedAt: videoUploads.startedAt })
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId))
		.limit(1);
	return upload !== undefined && upload.startedAt >= since;
}

// The longest output a processing job may write for this video, or null when
// the free plan limit does not apply. Pro is decided like multipart uploads
// and dashboard imports: the video owner or the organization owner being Pro
// lifts the limit.
export async function getFreePlanDurationLimit(video: {
	id: Video.VideoId;
	ownerId: User.UserId;
	orgId: Organisation.OrganisationId;
	source: { type: string; outputKey?: string };
	createdAt: Date;
	metadata?: { loomDeferredProcessing?: unknown } | null;
}): Promise<number | null> {
	if (
		!buildEnv.NEXT_PUBLIC_IS_CAP ||
		video.metadata?.loomDeferredProcessing ||
		!desktopLimitAppliesTo(video)
	)
		return null;
	if (
		video.createdAt < FREE_PLAN_MEASURED_DURATION_ENFORCED_FROM &&
		!(await hasUploadSince(video.id, FREE_PLAN_MEASURED_DURATION_ENFORCED_FROM))
	)
		return null;

	if (await ownerOrOrganizationHasPro(video.ownerId, video.orgId)) return null;

	const [imported] = await db()
		.select({ id: importedVideos.id })
		.from(importedVideos)
		.where(eq(importedVideos.id, video.id))
		.limit(1);
	if (imported) return null;

	return FREE_PLAN_MAX_MEASURED_SECONDS;
}
