import { db } from "@cap/database";
import { sendEmail } from "@cap/database/emails/config";
import { MessengerSupportEmail } from "@cap/database/emails/messenger-support-email";
import { s3Buckets, users, videos } from "@cap/database/schema";
import { buildEnv } from "@cap/env";
import type { User, Video } from "@cap/web-domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
	applyMediaInputPolicyStrike,
	MEDIA_INPUT_POLICY_STRIKE_THRESHOLD,
	readMediaInputPolicyState,
} from "@/lib/media-processing-policy";

const OPS_NOTIFICATION_EMAIL = "hello@cap.so";
const OPS_NOTIFICATION_FROM = "Cap Support <richie@send.cap.so>";

async function notifyMediaProcessingSuspended(input: {
	userId: User.UserId;
	email: string;
	suspendedAt: string;
}) {
	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true") return;
	try {
		const delivery = await sendEmail({
			email: OPS_NOTIFICATION_EMAIL,
			subject: `Media processing suspended for ${input.userId}`,
			react: MessengerSupportEmail({
				userEmail: input.email,
				conversationId: input.userId,
				message: `Media processing was suspended for user ${input.userId} after ${MEDIA_INPUT_POLICY_STRIKE_THRESHOLD} rejected processing inputs within 24 hours. Their personal custom storage was deactivated. Clear preferences.mediaInputPolicy on the user to restore processing.`,
			}),
			fromOverride: OPS_NOTIFICATION_FROM,
			idempotencyKey: `media-processing-suspended-${input.userId}-${input.suspendedAt}`,
		});
		if (delivery?.error) {
			console.error("[media-input-policy] suspension notice not sent", {
				userId: input.userId,
				error: delivery.error.message,
			});
		}
	} catch (error) {
		console.error("[media-input-policy] suspension notice not sent", {
			userId: input.userId,
			error,
		});
	}
}

export async function recordMediaInputPolicyStrike(input: {
	videoId: Video.VideoId;
	now?: Date;
}): Promise<{ recorded: boolean; suspended: boolean } | null> {
	const [video] = await db()
		.select({ ownerId: videos.ownerId })
		.from(videos)
		.where(eq(videos.id, input.videoId))
		.limit(1);
	if (!video) return null;
	const ownerId = video.ownerId;
	const at = (input.now ?? new Date()).getTime();

	const result = await db().transaction(async (tx) => {
		const [user] = await tx
			.select({ email: users.email, preferences: users.preferences })
			.from(users)
			.where(eq(users.id, ownerId))
			.limit(1)
			.for("update");
		if (!user) return null;
		const outcome = applyMediaInputPolicyStrike(
			readMediaInputPolicyState(user.preferences),
			{ at, videoId: input.videoId },
		);
		await tx
			.update(users)
			.set({
				preferences: sql`JSON_SET(COALESCE(${users.preferences}, JSON_OBJECT()), '$.mediaInputPolicy', CAST(${JSON.stringify(outcome.state)} AS JSON))`,
			})
			.where(eq(users.id, ownerId));
		if (outcome.state.suspendedAt) {
			await tx
				.update(s3Buckets)
				.set({ active: false })
				.where(
					and(
						eq(s3Buckets.ownerId, ownerId),
						isNull(s3Buckets.organizationId),
						eq(s3Buckets.active, true),
					),
				);
		}
		return { ...outcome, email: user.email };
	});
	if (!result) return null;

	if (result.newlySuspended) {
		console.error("[media-input-policy] processing suspended", {
			userId: ownerId,
			action: "suspend_media_processing",
			outcome: "applied",
			reason: "input_policy_strikes",
			videoId: input.videoId,
			clientIp: null,
		});
		await notifyMediaProcessingSuspended({
			userId: ownerId,
			email: result.email,
			suspendedAt: result.state.suspendedAt ?? new Date(at).toISOString(),
		});
	}
	return {
		recorded: result.recorded,
		suspended: result.state.suspendedAt !== undefined,
	};
}
