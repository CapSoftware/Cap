import { db } from "@cap/database";
import { sendEmail } from "@cap/database/emails/config";
import { InfraOutOfCredit } from "@cap/database/emails/infra-out-of-credit";
import { InfraTopUpFailed } from "@cap/database/emails/infra-top-up-failed";
import {
	developerApps,
	developerCreditAccounts,
	users,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { eq } from "drizzle-orm";
import { canUseInfra } from "@/lib/infra-access";
import { infraAppPath } from "@/lib/infra-routes";

const dayFormat = new Intl.DateTimeFormat("en-US", {
	month: "long",
	day: "numeric",
	timeZone: "UTC",
});

export function infraBillingEmailsEnabled() {
	return serverEnv().CAP_INFRA_BILLING_EMAILS === true;
}

async function recipientFor(accountId: string) {
	const [row] = await db()
		.select({
			appId: developerApps.id,
			appName: developerApps.name,
			email: users.email,
		})
		.from(developerCreditAccounts)
		.innerJoin(
			developerApps,
			eq(developerCreditAccounts.appId, developerApps.id),
		)
		.innerJoin(users, eq(developerCreditAccounts.ownerId, users.id))
		.where(eq(developerCreditAccounts.id, accountId))
		.limit(1);
	if (!row?.email || !canUseInfra(row.email)) return null;
	return {
		email: row.email,
		appName: row.appName,
		billingUrl: `${serverEnv().WEB_URL}${infraAppPath(row.appId, "billing")}`,
	};
}

export async function sendInfraOutOfCreditEmail({
	accountId,
	shortSince,
	pausesAt,
}: {
	accountId: string;
	shortSince: Date;
	pausesAt: Date;
}) {
	if (!infraBillingEmailsEnabled()) return false;
	try {
		const recipient = await recipientFor(accountId);
		if (!recipient) return false;
		await sendEmail({
			email: recipient.email,
			subject: `${recipient.appName} is out of Cap Infra credit`,
			react: InfraOutOfCredit({
				...recipient,
				pausesOn: dayFormat.format(pausesAt),
			}),
			idempotencyKey: `infra-out-of-credit-${accountId}-${shortSince.toISOString().slice(0, 10)}`,
		});
		return true;
	} catch (error) {
		console.error("[infra-billing] Out of credit email failed", error);
		return false;
	}
}

export async function sendInfraTopUpFailedEmail({
	accountId,
	referenceId,
	amountCents,
}: {
	accountId: string;
	referenceId: string;
	amountCents: number;
}) {
	if (!infraBillingEmailsEnabled()) return false;
	try {
		const recipient = await recipientFor(accountId);
		if (!recipient) return false;
		await sendEmail({
			email: recipient.email,
			subject: `The auto top-up for ${recipient.appName} was declined`,
			react: InfraTopUpFailed({
				...recipient,
				amount: `$${(amountCents / 100).toFixed(2)}`,
			}),
			idempotencyKey: `infra-top-up-failed-${accountId}-${referenceId}`,
		});
		return true;
	} catch (error) {
		console.error("[infra-billing] Failed top-up email failed", error);
		return false;
	}
}
