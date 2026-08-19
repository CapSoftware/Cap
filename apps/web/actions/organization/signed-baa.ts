"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { sendEmail } from "@cap/database/emails/config";
import { SignedBaa } from "@cap/database/emails/signed-baa";
import { nanoId } from "@cap/database/helpers";
import { organizations, signedBaas } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { STRIPE_SIGNED_BAA_PRICE_IDS, stripe, userIsPro } from "@cap/utils";
import type { Organisation } from "@cap/web-domain";
import { and, eq, lt, ne, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type Stripe from "stripe";
import {
	formatBaaDate,
	generateSignedBaaPdf,
} from "@/lib/baa/generate-signed-baa-pdf";

const BAA_NOTICE_EMAIL = "hello@cap.so";
const PROCESSING_STALE_MS = 2 * 60 * 1000;
const ENTITLED_STATUSES = new Set(["active", "trialing", "past_due"]);

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}
	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

export type SignedBaaInput = {
	entityName: string;
	entityType: string;
	entityAddress: string;
	signerName: string;
	signerTitle: string;
	noticesEmail: string;
	signatureDataUrl: string;
};

export type SignedBaaStatus = {
	status: "none" | "active" | "canceled";
	signedAt: string | null;
	entityName: string | null;
	emailSentAt: string | null;
	canPurchase: boolean;
};

function getBaaPriceId() {
	const environment =
		serverEnv().VERCEL_ENV === "production" ? "production" : "development";
	const priceId = STRIPE_SIGNED_BAA_PRICE_IDS[environment];
	if (!priceId || priceId.includes("REPLACE")) {
		throw new Error(
			"Signed BAA billing is not configured. Please contact support.",
		);
	}
	return priceId;
}

async function getOwnerContext(organizationId: Organisation.OrganisationId) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const [organization] = await db()
		.select()
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);

	if (!organization) throw new Error("Organization not found");
	if (organization.ownerId !== user.id)
		throw new Error("Only the organization owner can manage the Signed BAA");

	return { user, organization };
}

export async function getSignedBaaStatus(
	organizationId: Organisation.OrganisationId,
): Promise<SignedBaaStatus> {
	const { user } = await getOwnerContext(organizationId);

	const [record] = await db()
		.select()
		.from(signedBaas)
		.where(eq(signedBaas.organizationId, organizationId))
		.limit(1);

	const status =
		record?.status === "active"
			? "active"
			: record?.status === "canceled"
				? "canceled"
				: "none";

	return {
		status,
		signedAt:
			status === "active" && record?.signedAt
				? record.signedAt.toISOString()
				: null,
		entityName: status === "active" ? (record?.entityName ?? null) : null,
		emailSentAt:
			status === "active" && record?.emailSentAt
				? record.emailSentAt.toISOString()
				: null,
		canPurchase: Boolean(user.stripeCustomerId && userIsPro(user)),
	};
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SIGNATURE_PREFIX = "data:image/png;base64,";

function validateInput(input: SignedBaaInput) {
	const trimmed = {
		entityName: input.entityName.trim(),
		entityType: input.entityType.trim(),
		entityAddress: input.entityAddress.trim(),
		signerName: input.signerName.trim(),
		signerTitle: input.signerTitle.trim(),
		noticesEmail: input.noticesEmail.trim().toLowerCase(),
		signatureDataUrl: input.signatureDataUrl,
	};

	const requireLength = (value: string, label: string, max: number) => {
		if (value.length < 2 || value.length > max) {
			throw new Error(`${label} must be between 2 and ${max} characters`);
		}
	};

	requireLength(trimmed.entityName, "Company legal name", 255);
	requireLength(trimmed.entityType, "Entity type", 255);
	requireLength(trimmed.entityAddress, "Company address", 500);
	requireLength(trimmed.signerName, "Your name", 255);
	requireLength(trimmed.signerTitle, "Your title", 255);
	if (
		!EMAIL_REGEX.test(trimmed.noticesEmail) ||
		trimmed.noticesEmail.length > 255
	) {
		throw new Error("Please provide a valid notices email address");
	}
	if (
		!trimmed.signatureDataUrl.startsWith(SIGNATURE_PREFIX) ||
		trimmed.signatureDataUrl.length < 200 ||
		trimmed.signatureDataUrl.length > 700_000
	) {
		throw new Error("Please provide a valid signature");
	}

	return trimmed;
}

async function resolvePaymentMethod(
	customerId: string,
	proSubscriptionId: string | null,
): Promise<{ paymentMethod?: string }> {
	if (proSubscriptionId) {
		try {
			const proSub = await stripe().subscriptions.retrieve(proSubscriptionId);
			const pm = proSub.default_payment_method;
			if (pm) return { paymentMethod: typeof pm === "string" ? pm : pm.id };
		} catch (error) {
			console.error(
				"Signed BAA: failed to read Pro subscription payment method",
				error,
			);
		}
	}

	const customer = await stripe().customers.retrieve(customerId);
	if (!customer.deleted) {
		const invoiceDefault = customer.invoice_settings?.default_payment_method;
		// A customer-level default (payment method or legacy source) is applied
		// by Stripe automatically, so no explicit override is needed.
		if (invoiceDefault || customer.default_source) return {};
	}

	const methods = await stripe().paymentMethods.list({
		customer: customerId,
		type: "card",
		limit: 1,
	});
	const method = methods.data[0];
	if (method) return { paymentMethod: method.id };

	throw new Error(
		"No payment method on file. Add a card via Manage Billing first, then try again.",
	);
}

async function findExistingBaaSubscription(
	customerId: string,
	organizationId: string,
) {
	const subscriptions = await stripe().subscriptions.list({
		customer: customerId,
		status: "all",
		limit: 100,
	});
	return (
		subscriptions.data.find(
			(sub) =>
				sub.metadata?.type === "signed_baa" &&
				sub.metadata?.organizationId === organizationId &&
				ENTITLED_STATUSES.has(sub.status),
		) ?? null
	);
}

function throwSignedBaaStripeError(error: unknown): never {
	const stripeError = error as { type?: string; message?: string };
	if (stripeError.type === "StripeCardError") {
		throw new Error(
			`Your card was declined: ${stripeError.message ?? "payment failed"}. No subscription was started.`,
		);
	}
	if (error instanceof Error && error.message.includes("payment method")) {
		throw error;
	}
	console.error("Signed BAA: subscription creation failed", error);
	throw new Error(
		"We couldn't confirm the Signed BAA subscription. Please try again or contact support if you were charged.",
	);
}

async function createBaaSubscription({
	customerId,
	organizationId,
	userId,
	recordId,
	proSubscriptionId,
	priceId,
}: {
	customerId: string;
	organizationId: string;
	userId: string;
	recordId: string;
	proSubscriptionId: string | null;
	priceId: string;
}): Promise<Stripe.Subscription> {
	const existing = await findExistingBaaSubscription(
		customerId,
		organizationId,
	);
	if (existing) return existing;

	const { paymentMethod } = await resolvePaymentMethod(
		customerId,
		proSubscriptionId,
	);
	return stripe().subscriptions.create(
		{
			customer: customerId,
			items: [{ price: priceId, quantity: 1 }],
			...(paymentMethod ? { default_payment_method: paymentMethod } : {}),
			payment_behavior: "error_if_incomplete",
			metadata: {
				type: "signed_baa",
				organizationId,
				userId,
			},
		},
		{ idempotencyKey: `signed-baa-${recordId}` },
	);
}

export async function purchaseSignedBaa(
	organizationId: Organisation.OrganisationId,
	input: SignedBaaInput,
): Promise<{ success: true; emailSent: boolean }> {
	const details = validateInput(input);
	const { user } = await getOwnerContext(organizationId);
	const priceId = getBaaPriceId();

	if (!user.stripeCustomerId || !userIsPro(user)) {
		throw new Error(
			"Your organization needs an active Cap Pro subscription before adding the Signed BAA add-on.",
		);
	}
	const customerId = user.stripeCustomerId;

	const [existing] = await db()
		.select()
		.from(signedBaas)
		.where(eq(signedBaas.organizationId, organizationId))
		.limit(1);

	if (existing?.status === "active" && existing.emailSentAt) {
		throw new Error("A Signed BAA is already active for this organization.");
	}

	const { signatureDataUrl, ...contractFields } = details;
	const recordFields = { ...contractFields, signatureData: signatureDataUrl };

	// Claim the record so concurrent submissions can never both reach Stripe.
	// A "processing" row blocks other requests until it goes stale (crashed
	// attempt) or resolves to active/pending.
	const isEmailRetry = existing?.status === "active";
	let recordId: string;
	if (existing) {
		recordId = existing.id;
		const staleBefore = new Date(Date.now() - PROCESSING_STALE_MS);
		const claim = await db()
			.update(signedBaas)
			.set({
				status: "processing",
				userId: user.id,
				...recordFields,
				...(isEmailRetry ? {} : { signedAt: null, emailSentAt: null }),
			})
			.where(
				and(
					eq(signedBaas.id, existing.id),
					or(
						ne(signedBaas.status, "processing"),
						lt(signedBaas.updatedAt, staleBefore),
					),
				),
			);
		if (getAffectedRows(claim) === 0) {
			throw new Error(
				"A Signed BAA purchase is already in progress. Please wait a moment and refresh.",
			);
		}
	} else {
		recordId = nanoId();
		try {
			await db()
				.insert(signedBaas)
				.values({
					id: recordId,
					organizationId,
					userId: user.id,
					status: "processing",
					...recordFields,
				});
		} catch {
			throw new Error(
				"A Signed BAA purchase is already in progress. Please wait a moment and refresh.",
			);
		}
	}

	const revertToPending = async () => {
		await db()
			.update(signedBaas)
			.set({ status: existing?.status === "canceled" ? "canceled" : "pending" })
			.where(eq(signedBaas.id, recordId));
	};

	const signedAt = (isEmailRetry ? existing?.signedAt : null) ?? new Date();

	// Generate the PDF before charging so a malformed signature can never
	// leave the customer charged without a document.
	let pdf: Uint8Array;
	try {
		pdf = await generateSignedBaaPdf({
			...details,
			executionId: recordId,
			signedAt,
		});
	} catch (error) {
		console.error("Signed BAA: PDF generation failed", error);
		await revertToPending();
		throw new Error(
			"We couldn't generate the agreement from your signature. Please clear the signature and try again.",
		);
	}

	let subscription: Stripe.Subscription | null = null;
	try {
		subscription = await createBaaSubscription({
			customerId,
			organizationId,
			userId: user.id,
			recordId,
			proSubscriptionId: user.stripeSubscriptionId,
			priceId,
		});
	} catch (error) {
		try {
			subscription = await createBaaSubscription({
				customerId,
				organizationId,
				userId: user.id,
				recordId,
				proSubscriptionId: user.stripeSubscriptionId,
				priceId,
			});
		} catch (retryError) {
			await revertToPending();
			throwSignedBaaStripeError(retryError ?? error);
		}
	}

	if (!subscription) {
		await revertToPending();
		throw new Error(
			"We couldn't confirm the Signed BAA subscription. Please try again or contact support if you were charged.",
		);
	}

	await db()
		.update(signedBaas)
		.set({
			status: "active",
			stripeSubscriptionId: subscription.id,
			signedAt,
		})
		.where(eq(signedBaas.id, recordId));

	let emailSent = Boolean(existing?.emailSentAt);
	if (!emailSent) {
		try {
			await sendEmail({
				email: user.email,
				cc: [
					BAA_NOTICE_EMAIL,
					...(details.noticesEmail !== user.email.toLowerCase()
						? [details.noticesEmail]
						: []),
				],
				subject: "Your signed BAA with Cap",
				react: SignedBaa({
					email: user.email,
					entityName: details.entityName,
					effectiveDate: formatBaaDate(signedAt),
				}),
				fromOverride: "Cap Software <richie@send.cap.so>",
				replyTo: BAA_NOTICE_EMAIL,
				attachments: [
					{
						filename: "Cap-Software-BAA-Signed.pdf",
						content: Buffer.from(pdf),
						contentType: "application/pdf",
					},
				],
				idempotencyKey: `signed-baa-email-${recordId}`,
			});
			await db()
				.update(signedBaas)
				.set({ emailSentAt: new Date() })
				.where(eq(signedBaas.id, recordId));
			emailSent = true;
		} catch (error) {
			console.error("Signed BAA: email delivery failed", error);
		}
	}

	revalidatePath("/dashboard/settings/organization");

	return { success: true, emailSent };
}
