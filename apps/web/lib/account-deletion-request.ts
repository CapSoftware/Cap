import "server-only";

import { db } from "@cap/database";
import { sendEmail } from "@cap/database/emails/config";
import { MessengerSupportEmail } from "@cap/database/emails/messenger-support-email";
import { nanoId } from "@cap/database/helpers";
import {
	messengerConversations,
	messengerMessages,
	messengerSupportEmails,
	users,
} from "@cap/database/schema";
import type { User, Video } from "@cap/web-domain";
import { and, eq, or } from "drizzle-orm";

const ACCOUNT_DELETION_EMAIL_TO = "hello@cap.so";
const ACCOUNT_DELETION_EMAIL_FROM = "Cap Support <richie@send.cap.so>";
export const ACCOUNT_DELETION_PENDING_SUBJECT =
	"[PENDING] Account deletion request";
export const MOBILE_CONTENT_REPORT_PENDING_SUBJECT =
	"[PENDING] Mobile content report";

type AccountDeletionUser = {
	id: User.UserId;
	email: string;
	name?: string | null;
};

const createRequestMessage = (user: AccountDeletionUser, now: Date) =>
	[
		"An account deletion request was initiated and confirmed inside the Cap mobile app.",
		"",
		`User ID: ${user.id}`,
		`Email: ${user.email}`,
		`Requested at: ${now.toISOString()}`,
		"",
		"Complete permanent deletion of the account and associated personal data, Caps, videos, comments, profile data, and organizations owned solely by this user within 30 days. Cancel any direct Cap subscription that remains active. Confirm completion to the user by email, then change this request subject from [PENDING] to [COMPLETED].",
	].join("\n");

export const hasPendingAccountDeletion = async ({
	userId,
	email,
}: {
	userId?: User.UserId;
	email?: string;
}) => {
	const identities = [
		userId ? eq(messengerSupportEmails.userId, userId) : undefined,
		email
			? eq(messengerSupportEmails.userEmail, email.trim().toLowerCase())
			: undefined,
	].filter((condition) => condition !== undefined);

	if (identities.length === 0) return false;

	const identity = identities.length === 1 ? identities[0] : or(...identities);
	const [request] = await db()
		.select({ id: messengerSupportEmails.id })
		.from(messengerSupportEmails)
		.where(
			and(
				eq(messengerSupportEmails.subject, ACCOUNT_DELETION_PENDING_SUBJECT),
				identity,
			),
		)
		.limit(1);

	return Boolean(request);
};

export const createAccountDeletionRequest = async ({
	user,
	now = new Date(),
}: {
	user: AccountDeletionUser;
	now?: Date;
}) => {
	const normalizedUser = {
		...user,
		email: user.email.trim().toLowerCase(),
	};
	const request = await db().transaction(async (tx) => {
		const [lockedUser] = await tx
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, normalizedUser.id))
			.for("update");

		if (!lockedUser) {
			throw new Error("Account deletion user not found");
		}

		const [existing] = await tx
			.select({
				id: messengerSupportEmails.id,
				conversationId: messengerSupportEmails.conversationId,
				message: messengerSupportEmails.message,
			})
			.from(messengerSupportEmails)
			.where(
				and(
					eq(messengerSupportEmails.userId, normalizedUser.id),
					eq(messengerSupportEmails.subject, ACCOUNT_DELETION_PENDING_SUBJECT),
				),
			)
			.limit(1);

		if (existing) {
			return {
				...existing,
				status: "existing" as const,
			};
		}

		const id = nanoId();
		const conversationId = nanoId();
		const messageId = nanoId();
		const message = createRequestMessage(normalizedUser, now);
		await tx.insert(messengerConversations).values({
			id: conversationId,
			agent: "Millie",
			mode: "human",
			userId: normalizedUser.id,
			createdAt: now,
			updatedAt: now,
			lastMessageAt: now,
		});
		await tx.insert(messengerMessages).values({
			id: messageId,
			conversationId,
			role: "user",
			content: message,
			userId: normalizedUser.id,
			createdAt: now,
		});
		await tx.insert(messengerSupportEmails).values({
			id,
			conversationId,
			userId: normalizedUser.id,
			userEmail: normalizedUser.email,
			subject: ACCOUNT_DELETION_PENDING_SUBJECT,
			message,
			createdAt: now,
		});

		return {
			id,
			conversationId,
			message,
			status: "created" as const,
		};
	});

	const notificationSent = await sendEmail({
		email: ACCOUNT_DELETION_EMAIL_TO,
		subject: ACCOUNT_DELETION_PENDING_SUBJECT,
		react: MessengerSupportEmail({
			userEmail: normalizedUser.email,
			userName: normalizedUser.name,
			conversationId: request.conversationId,
			message: request.message,
		}),
		replyTo: normalizedUser.email,
		fromOverride: ACCOUNT_DELETION_EMAIL_FROM,
		idempotencyKey: `account-deletion-${request.id}`,
	})
		.then(() => true)
		.catch(() => false);

	return {
		id: request.id,
		status: request.status,
		notificationSent,
	};
};

export const createMobileContentReport = async ({
	reporter,
	content,
	reason,
	now = new Date(),
}: {
	reporter: AccountDeletionUser;
	content: {
		id: Video.VideoId;
		ownerId: User.UserId;
		title: string;
	};
	reason: "harassment" | "hate" | "sexual" | "violence" | "copyright" | "other";
	now?: Date;
}) => {
	const normalizedReporter = {
		...reporter,
		email: reporter.email.trim().toLowerCase(),
	};
	const message = [
		"A signed-in user reported a Cap from the iOS app.",
		"",
		`Reporter user ID: ${normalizedReporter.id}`,
		`Reporter email: ${normalizedReporter.email}`,
		`Cap ID: ${content.id}`,
		`Cap title: ${content.title}`,
		`Cap owner ID: ${content.ownerId}`,
		`Reason: ${reason}`,
		`Reported at: ${now.toISOString()}`,
		`Cap URL: https://cap.so/s/${content.id}`,
		"",
		"Review the content promptly, remove it if it violates Cap policies, respond to the reporter when appropriate, and change this request subject from [PENDING] to [COMPLETED].",
	].join("\n");
	const request = await db().transaction(async (tx) => {
		const [lockedUser] = await tx
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, normalizedReporter.id))
			.for("update");

		if (!lockedUser) {
			throw new Error("Content report user not found");
		}

		const id = nanoId();
		const conversationId = nanoId();
		const messageId = nanoId();
		await tx.insert(messengerConversations).values({
			id: conversationId,
			agent: "Millie",
			mode: "human",
			userId: normalizedReporter.id,
			createdAt: now,
			updatedAt: now,
			lastMessageAt: now,
		});
		await tx.insert(messengerMessages).values({
			id: messageId,
			conversationId,
			role: "user",
			content: message,
			userId: normalizedReporter.id,
			createdAt: now,
		});
		await tx.insert(messengerSupportEmails).values({
			id,
			conversationId,
			userId: normalizedReporter.id,
			userEmail: normalizedReporter.email,
			subject: MOBILE_CONTENT_REPORT_PENDING_SUBJECT,
			message,
			createdAt: now,
		});

		return { id, conversationId };
	});

	const notificationSent = await sendEmail({
		email: ACCOUNT_DELETION_EMAIL_TO,
		subject: MOBILE_CONTENT_REPORT_PENDING_SUBJECT,
		react: MessengerSupportEmail({
			userEmail: normalizedReporter.email,
			userName: normalizedReporter.name,
			conversationId: request.conversationId,
			message,
		}),
		replyTo: normalizedReporter.email,
		fromOverride: ACCOUNT_DELETION_EMAIL_FROM,
		idempotencyKey: `mobile-content-report-${request.id}`,
	})
		.then(() => true)
		.catch(() => false);

	return {
		id: request.id,
		notificationSent,
	};
};
