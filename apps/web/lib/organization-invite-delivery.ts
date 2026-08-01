import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import { sendEmail } from "@cap/database/emails/config";
import { OrganizationInvite } from "@cap/database/emails/organization-invite";
import { organizationInvites, organizations } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import {
	attemptProductAnalyticsOutboxDelivery,
	persistProductAnalyticsEvent,
} from "./analytics/product-event-outbox";

const MAX_DELIVERY_BATCH_SIZE = 25;
const MAX_DELIVERY_RETRY_DELAY_MS = 60 * 60 * 1_000;
const MAX_DELIVERY_ATTEMPTS = 12;
const INVITE_DELIVERY_SLO_MS = 15 * 60 * 1_000;
const INVITE_DELIVERY_LEASE_MS = 5 * 60 * 1_000;

async function deferOrganizationInviteDelivery(
	inviteId: string,
	leaseOwnerId: string,
) {
	const [invite] = await db()
		.select({
			attemptCount: organizationInvites.emailDeliveryAttemptCount,
		})
		.from(organizationInvites)
		.where(
			and(
				eq(organizationInvites.id, inviteId),
				eq(organizationInvites.emailDeliveryState, "pending"),
				eq(organizationInvites.emailDeliveryLeaseOwnerId, leaseOwnerId),
			),
		)
		.limit(1);
	if (!invite) return;
	const attemptCount = invite.attemptCount;
	const retryDelay = Math.min(
		MAX_DELIVERY_RETRY_DELAY_MS,
		2 ** Math.min(attemptCount, 10) * 1_000,
	);
	const deadLettered = attemptCount >= MAX_DELIVERY_ATTEMPTS;
	await db()
		.update(organizationInvites)
		.set({
			emailDeliveryState: deadLettered ? "dead_letter" : "pending",
			emailDeliveryAttemptCount: attemptCount,
			emailDeliveryNextAttemptAt: deadLettered
				? null
				: new Date(Date.now() + retryDelay),
			emailDeliveryErrorCode: deadLettered
				? "provider_delivery_dead_letter"
				: "provider_send_failed",
			emailDeliveryLeaseOwnerId: null,
			emailDeliveryLeaseExpiresAt: null,
		})
		.where(
			and(
				eq(organizationInvites.id, inviteId),
				eq(organizationInvites.emailDeliveryState, "pending"),
				eq(organizationInvites.emailDeliveryLeaseOwnerId, leaseOwnerId),
			),
		);
}

export async function deliverOrganizationInvite(inviteId: string) {
	const leaseOwnerId = randomUUID();
	const claimed = await db().transaction(async (tx) => {
		const now = new Date();
		const [invite] = await tx
			.select({
				id: organizationInvites.id,
				organizationId: organizationInvites.organizationId,
				organizationName: organizations.name,
				invitedEmail: organizationInvites.invitedEmail,
				invitedByUserId: organizationInvites.invitedByUserId,
				role: organizationInvites.role,
			})
			.from(organizationInvites)
			.innerJoin(
				organizations,
				eq(organizations.id, organizationInvites.organizationId),
			)
			.where(
				and(
					eq(organizationInvites.id, inviteId),
					eq(organizationInvites.status, "pending"),
					isNull(organizations.tombstoneAt),
					eq(organizationInvites.emailDeliveryState, "pending"),
					or(
						isNull(organizationInvites.expiresAt),
						gt(organizationInvites.expiresAt, now),
					),
					or(
						isNull(organizationInvites.emailDeliveryNextAttemptAt),
						lte(organizationInvites.emailDeliveryNextAttemptAt, now),
					),
					or(
						isNull(organizationInvites.emailDeliveryLeaseOwnerId),
						isNull(organizationInvites.emailDeliveryLeaseExpiresAt),
						lte(organizationInvites.emailDeliveryLeaseExpiresAt, now),
					),
				),
			)
			.limit(1)
			.for("update");
		if (!invite) return undefined;
		await tx
			.update(organizationInvites)
			.set({
				emailDeliveryAttemptCount: sql`${organizationInvites.emailDeliveryAttemptCount} + 1`,
				emailDeliveryLeaseOwnerId: leaseOwnerId,
				emailDeliveryLeaseExpiresAt: new Date(
					now.getTime() + INVITE_DELIVERY_LEASE_MS,
				),
			})
			.where(eq(organizationInvites.id, inviteId));
		return invite;
	});
	if (!claimed) return { status: "not_pending" as const };

	try {
		if (!serverEnv().RESEND_API_KEY) {
			throw new Error("Organization invite email provider is not configured");
		}
		const result = await sendEmail({
			email: claimed.invitedEmail,
			subject: `Invitation to join ${claimed.organizationName} on Cap`,
			react: OrganizationInvite({
				email: claimed.invitedEmail,
				url: `${serverEnv().WEB_URL}/invite/${claimed.id}`,
				organizationName: claimed.organizationName,
			}),
			idempotencyKey: `organization-invite:${claimed.id}`,
		});
		const providerMessageId = result?.data?.id;
		if (!result || result.error || !providerMessageId) {
			throw new Error("Organization invite provider rejected delivery");
		}
		const eventId = await db().transaction(async (tx) => {
			const now = new Date();
			const [invite] = await tx
				.select({
					id: organizationInvites.id,
					organizationId: organizationInvites.organizationId,
					organizationName: organizations.name,
					invitedEmail: organizationInvites.invitedEmail,
					invitedByUserId: organizationInvites.invitedByUserId,
					role: organizationInvites.role,
				})
				.from(organizationInvites)
				.innerJoin(
					organizations,
					eq(organizations.id, organizationInvites.organizationId),
				)
				.where(
					and(
						eq(organizationInvites.id, inviteId),
						eq(organizationInvites.status, "pending"),
						isNull(organizations.tombstoneAt),
						eq(organizationInvites.emailDeliveryState, "pending"),
						eq(organizationInvites.emailDeliveryLeaseOwnerId, leaseOwnerId),
						or(
							isNull(organizationInvites.expiresAt),
							gt(organizationInvites.expiresAt, now),
						),
					),
				)
				.limit(1)
				.for("update");
			if (!invite) return undefined;
			const sentAt = new Date();
			const analyticsEventId = `organization_invite:${inviteId}:sent`;
			await tx
				.update(organizationInvites)
				.set({
					emailDeliveryState: "sent",
					emailDeliveryNextAttemptAt: null,
					emailDeliveryErrorCode: null,
					emailDeliveryLeaseOwnerId: null,
					emailDeliveryLeaseExpiresAt: null,
					emailProviderMessageId: providerMessageId,
					emailSentAt: sentAt,
				})
				.where(eq(organizationInvites.id, inviteId));
			await persistProductAnalyticsEvent(tx, {
				eventId: analyticsEventId,
				eventName: "organization_invite_sent",
				occurredAt: sentAt.toISOString(),
				platform: "web",
				userId: invite.invitedByUserId,
				organizationId: invite.organizationId,
				properties: {
					invite_count: 1,
					admin_count: invite.role === "admin" ? 1 : 0,
					member_count: invite.role === "admin" ? 0 : 1,
					delivery: "email",
				},
			});
			return analyticsEventId;
		});
		if (!eventId) return { status: "not_pending" as const };
		await attemptProductAnalyticsOutboxDelivery(eventId);
		return { status: "sent" as const };
	} catch {
		await deferOrganizationInviteDelivery(inviteId, leaseOwnerId);
		return { status: "deferred" as const };
	}
}

export async function recoverOrganizationInviteDeliveries(
	limit = MAX_DELIVERY_BATCH_SIZE,
) {
	const boundedLimit = Math.max(1, Math.min(limit, MAX_DELIVERY_BATCH_SIZE));
	const pending = await db()
		.select({ id: organizationInvites.id })
		.from(organizationInvites)
		.innerJoin(
			organizations,
			eq(organizations.id, organizationInvites.organizationId),
		)
		.where(
			and(
				eq(organizationInvites.emailDeliveryState, "pending"),
				eq(organizationInvites.status, "pending"),
				isNull(organizations.tombstoneAt),
				or(
					isNull(organizationInvites.expiresAt),
					gt(organizationInvites.expiresAt, new Date()),
				),
				or(
					isNull(organizationInvites.emailDeliveryNextAttemptAt),
					lte(organizationInvites.emailDeliveryNextAttemptAt, new Date()),
				),
				or(
					isNull(organizationInvites.emailDeliveryLeaseOwnerId),
					isNull(organizationInvites.emailDeliveryLeaseExpiresAt),
					lte(organizationInvites.emailDeliveryLeaseExpiresAt, new Date()),
				),
			),
		)
		.orderBy(asc(organizationInvites.createdAt))
		.limit(boundedLimit);

	let sent = 0;
	let deferred = 0;
	for (const invite of pending) {
		const result = await deliverOrganizationInvite(invite.id);
		if (result.status === "sent") sent += 1;
		if (result.status === "deferred") deferred += 1;
	}
	return { attempted: pending.length, sent, deferred };
}

export async function getOrganizationInviteDeliveryHealth() {
	const now = new Date();
	const [row] = await db()
		.select({
			pending: sql<number>`SUM(IF(${organizationInvites.emailDeliveryState} = 'pending', 1, 0))`,
			due: sql<number>`SUM(IF(${organizationInvites.emailDeliveryState} = 'pending' AND (${organizationInvites.emailDeliveryNextAttemptAt} IS NULL OR ${organizationInvites.emailDeliveryNextAttemptAt} <= ${now}), 1, 0))`,
			deadLetter: sql<number>`SUM(IF(${organizationInvites.emailDeliveryState} = 'dead_letter', 1, 0))`,
			oldestPendingAt: sql<
				Date | string | null
			>`MIN(IF(${organizationInvites.emailDeliveryState} = 'pending', ${organizationInvites.createdAt}, NULL))`,
		})
		.from(organizationInvites);
	const oldestTimestamp = row?.oldestPendingAt
		? row.oldestPendingAt instanceof Date
			? row.oldestPendingAt.getTime()
			: Date.parse(row.oldestPendingAt)
		: now.getTime();
	const oldestPendingAgeSeconds = Number.isFinite(oldestTimestamp)
		? Math.max(0, Math.floor((now.getTime() - oldestTimestamp) / 1_000))
		: 0;
	const pending = Number(row?.pending ?? 0);
	const deadLetter = Number(row?.deadLetter ?? 0);
	return {
		healthy:
			deadLetter === 0 &&
			oldestPendingAgeSeconds * 1_000 <= INVITE_DELIVERY_SLO_MS,
		pending,
		due: Number(row?.due ?? 0),
		deadLetter,
		oldestPendingAgeSeconds,
		oldestPendingSloSeconds: INVITE_DELIVERY_SLO_MS / 1_000,
	};
}

export async function requeueOrganizationInviteDelivery(inviteId: string) {
	await db()
		.update(organizationInvites)
		.set({
			emailDeliveryState: "pending",
			emailDeliveryNextAttemptAt: new Date(),
			emailDeliveryErrorCode: null,
			emailDeliveryAttemptCount: 0,
			emailDeliveryLeaseOwnerId: null,
			emailDeliveryLeaseExpiresAt: null,
		})
		.where(
			and(
				eq(organizationInvites.id, inviteId),
				eq(organizationInvites.emailDeliveryState, "dead_letter"),
			),
		);
}
