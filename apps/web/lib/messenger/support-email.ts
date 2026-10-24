import "server-only";

import { db } from "@cap/database";
import { sendEmail } from "@cap/database/emails/config";
import { MessengerSupportEmail } from "@cap/database/emails/messenger-support-email";
import { nanoId } from "@cap/database/helpers";
import { messengerSupportEmails, users } from "@cap/database/schema";
import type { User } from "@cap/web-domain";
import { and, count, eq, gte } from "drizzle-orm";

const SUPPORT_EMAIL_TO = "hello@cap.so";
const SUPPORT_EMAIL_FROM = "Cap Support <richie@send.cap.so>";
export const MESSENGER_SUPPORT_EMAIL_DAILY_LIMIT = 2;

type MessengerSupportUser = {
	id: User.UserId;
	email: string;
	name?: string | null;
};

const normalizeSubject = (subject: string, userEmail: string) => {
	const normalized = subject.replace(/\s+/g, " ").trim().slice(0, 140);
	return normalized || `Support request from ${userEmail}`;
};

const normalizeMessage = (message: string) => message.trim().slice(0, 4000);

export const getMessengerSupportEmailDayStart = (now = new Date()) => {
	const start = new Date(now);
	start.setUTCHours(0, 0, 0, 0);
	return start;
};

export const sendMessengerSupportEmail = async ({
	user,
	conversationId,
	subject,
	message,
	now = new Date(),
}: {
	user: MessengerSupportUser;
	conversationId: string;
	subject: string;
	message: string;
	now?: Date;
}) => {
	const normalizedSubject = normalizeSubject(subject, user.email);
	const normalizedMessage = normalizeMessage(message);
	if (!normalizedMessage) {
		throw new Error("Support email message is empty");
	}

	const reserved = await db().transaction(async (tx) => {
		const [lockedUser] = await tx
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, user.id))
			.for("update");

		if (!lockedUser) {
			throw new Error("Support email user not found");
		}

		const [row] = await tx
			.select({ value: count() })
			.from(messengerSupportEmails)
			.where(
				and(
					eq(messengerSupportEmails.userId, user.id),
					gte(
						messengerSupportEmails.createdAt,
						getMessengerSupportEmailDayStart(now),
					),
				),
			);
		const sentToday = row?.value ?? 0;

		if (sentToday >= MESSENGER_SUPPORT_EMAIL_DAILY_LIMIT) {
			return {
				status: "rate_limited" as const,
				remainingToday: 0 as const,
			};
		}

		await tx.insert(messengerSupportEmails).values({
			id: nanoId(),
			conversationId,
			userId: user.id,
			userEmail: user.email,
			subject: normalizedSubject,
			message: normalizedMessage,
			createdAt: now,
		});

		return {
			status: "sent" as const,
			remainingToday: Math.max(
				0,
				MESSENGER_SUPPORT_EMAIL_DAILY_LIMIT - sentToday - 1,
			),
		};
	});

	if (reserved.status === "rate_limited") {
		return reserved;
	}

	await sendEmail({
		email: SUPPORT_EMAIL_TO,
		subject: `Messenger support: ${normalizedSubject}`,
		react: MessengerSupportEmail({
			userEmail: user.email,
			userName: user.name,
			conversationId,
			message: normalizedMessage,
		}),
		replyTo: user.email,
		fromOverride: SUPPORT_EMAIL_FROM,
	});

	return reserved;
};
