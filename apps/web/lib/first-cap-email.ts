import { db } from "@cap/database";
import { sendEmail } from "@cap/database/emails/config";
import { FirstShareableLink } from "@cap/database/emails/first-shareable-link";
import {
	cancelScheduledFirstCapEmail,
	updateFirstCapEmailMarker,
} from "@cap/database/first-cap-email";
import { videos } from "@cap/database/schema";
import type { User, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";

const FIRST_CAP_EMAIL_DELAY_MS = 5 * 60 * 1000;

export async function scheduleFirstCapEmail({
	userId,
	email,
	videoId,
	videoName,
	url,
}: {
	userId: User.UserId;
	email: string;
	videoId: Video.VideoId;
	videoName: string;
	url: string;
}) {
	const sendAt = Date.now() + FIRST_CAP_EMAIL_DELAY_MS;
	const release = () =>
		updateFirstCapEmailMarker(userId, (current) =>
			current?.videoId === videoId ? null : undefined,
		);

	const claimed = await updateFirstCapEmailMarker(userId, (current) =>
		current ? undefined : { videoId, sendAt },
	);
	if (!claimed) return;

	const result = await sendEmail({
		email,
		subject: "You created your first Cap! 🥳",
		react: FirstShareableLink({ email, url, videoName }),
		marketing: true,
		scheduledAt: new Date(sendAt).toISOString(),
	});
	if (result?.error) {
		await release();
		return;
	}

	const emailId = result?.data?.id;
	if (!emailId) return;

	const recorded = await updateFirstCapEmailMarker(userId, (current) =>
		current?.videoId === videoId ? { ...current, emailId } : undefined,
	);
	if (recorded) {
		const [video] = await db()
			.select({ id: videos.id })
			.from(videos)
			.where(eq(videos.id, videoId))
			.limit(1);
		if (video) return;
	}

	// The recording was deleted while its email was being scheduled, so the
	// delete could not see an email to cancel. A cancel that fails keeps the
	// claim, which stops a second email going out on top of this one.
	if (await cancelScheduledFirstCapEmail(emailId)) await release();
	else if (!recorded)
		await updateFirstCapEmailMarker(userId, (current) =>
			current ? undefined : { videoId, sendAt, emailId },
		);
}
