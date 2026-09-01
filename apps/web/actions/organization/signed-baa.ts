"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { sendEmail } from "@cap/database/emails/config";
import { SignedBaa } from "@cap/database/emails/signed-baa";
import { nanoId } from "@cap/database/helpers";
import { organizations, signedBaas } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { STRIPE_SIGNED_BAA_PRICE_IDS, stripe } from "@cap/utils";
import type { Organisation } from "@cap/web-domain";
import { and, eq, isNull, lt, ne, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type Stripe from "stripe";
import {
	attachPaidBaaCheckout,
	BAA_ENTITLED_STATUSES,
	ensureBaaHasPro,
	hasBaaProWaiver,
	hasPaidBaaInvoice,
	isSignedBaaSubscription,
} from "@/lib/baa/billing";
import {
	formatBaaDate,
	generateSignedBaaPdf,
} from "@/lib/baa/generate-signed-baa-pdf";

const BAA_NOTICE_EMAIL = "hello@cap.so";
const PROCESSING_STALE_MS = 2 * 60 * 1000;
const ENTITLED_STATUSES = new Set(["active", "trialing", "past_due"]);
const CAP_PRO_STATUSES = new Set([
	"active",
	"trialing",
	"complete",
	"paid",
	"past_due",
]);

function ownerCanPurchaseSignedBaa(user: {
	stripeCustomerId?: string | null;
	stripeSubscriptionStatus?: string | null;
}) {
	return Boolean(
		user.stripeCustomerId &&
			user.stripeSubscriptionStatus &&
			CAP_PRO_STATUSES.has(user.stripeSubscriptionStatus),
	);
}

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
	status: "none" | "paid" | "active" | "canceled" | "processing";
	signedAt: string | null;
	entityName: string | null;
	emailSentAt: string | null;
	canPurchase: boolean;
	details: Omit<SignedBaaInput, "signatureDataUrl"> | null;
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

	const processing =
		record?.status === "processing" &&
		Date.now() - record.updatedAt.getTime() < PROCESSING_STALE_MS;
	const status = processing
		? "processing"
		: record?.status === "active" && record.signedAt
			? "active"
			: record?.status === "canceled"
				? "canceled"
				: record?.stripeSubscriptionId &&
						(record.status === "paid" ||
							record.status === "active" ||
							record.status === "processing")
					? "paid"
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
		canPurchase: ownerCanPurchaseSignedBaa(user),
		details: record
			? {
					entityName: record.entityName,
					entityType: record.entityType,
					entityAddress: record.entityAddress,
					signerName: record.signerName,
					signerTitle: record.signerTitle,
					noticesEmail: record.noticesEmail,
				}
			: null,
	};
}

export async function confirmSignedBaaPayment(
	organizationId: Organisation.OrganisationId,
	sessionId: string,
): Promise<SignedBaaStatus> {
	const { user } = await getOwnerContext(organizationId);
	if (!sessionId.startsWith("cs_") || sessionId.length > 255) {
		throw new Error("Invalid payment confirmation. Please contact support.");
	}
	const session = await stripe().checkout.sessions.retrieve(sessionId);
	const subscriptionId =
		typeof session.subscription === "string"
			? session.subscription
			: session.subscription?.id;
	if (!subscriptionId) {
		throw new Error("No BAA subscription was found for this payment.");
	}
	const subscription = await stripe().subscriptions.retrieve(subscriptionId);
	const record = await attachPaidBaaCheckout(session, subscription, {
		owner: user,
		organizationId,
	});
	if (!record) {
		throw new Error(
			"We couldn't confirm a paid BAA for this organization. Please retry once payment completes, or contact support. Do not pay again.",
		);
	}
	revalidatePath("/dashboard/settings/organization/billing");
	return getSignedBaaStatus(organizationId);
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
	return completeSignedBaa(organizationId, input, false);
}

export async function signPaidBaa(
	organizationId: Organisation.OrganisationId,
	input: SignedBaaInput,
): Promise<{ success: true; emailSent: boolean }> {
	return completeSignedBaa(organizationId, input, true);
}

async function completeSignedBaa(
	organizationId: Organisation.OrganisationId,
	input: SignedBaaInput,
	requirePaid: boolean,
): Promise<{ success: true; emailSent: boolean }> {
	const details = validateInput(input);
	const { user } = await getOwnerContext(organizationId);
	const priceId = getBaaPriceId();

	const customerId = user.stripeCustomerId ?? "";
	const [existing] = await db()
		.select()
		.from(signedBaas)
		.where(eq(signedBaas.organizationId, organizationId))
		.limit(1);

	if (existing?.status === "active" && existing.emailSentAt) {
		throw new Error("A Signed BAA is already active for this organization.");
	}
	let paidSubscription: Stripe.Subscription | null = null;
	if (existing?.stripeSubscriptionId && existing.status !== "canceled") {
		paidSubscription = await stripe().subscriptions.retrieve(
			existing.stripeSubscriptionId,
			{ expand: ["latest_invoice"] },
		);
		if (
			!isSignedBaaSubscription(paidSubscription) ||
			!BAA_ENTITLED_STATUSES.has(paidSubscription.status) ||
			(!existing.signedAt &&
				existing.status !== "paid" &&
				!hasPaidBaaInvoice(paidSubscription))
		) {
			throw new Error(
				"The existing BAA payment is not confirmed. Please contact support; no additional payment was taken.",
			);
		}
	}
	if (requirePaid && !paidSubscription) {
		throw new Error("A confirmed BAA payment is required before signing.");
	}

	const proRequirementWaived =
		existing?.userId === user.id &&
		paidSubscription &&
		hasBaaProWaiver(paidSubscription, existing);
	if (!proRequirementWaived) {
		if (
			!customerId ||
			!user.stripeSubscriptionId ||
			!ownerCanPurchaseSignedBaa(user)
		) {
			throw new Error(
				"Your organization needs an active Cap Pro subscription before adding the Signed BAA add-on.",
			);
		}

		let liveProSubscription: Stripe.Subscription;
		try {
			liveProSubscription = await stripe().subscriptions.retrieve(
				user.stripeSubscriptionId,
			);
		} catch {
			throw new Error(
				"Your organization needs an active Cap Pro subscription before adding the Signed BAA add-on.",
			);
		}
		if (
			!CAP_PRO_STATUSES.has(liveProSubscription.status) ||
			isSignedBaaSubscription(liveProSubscription)
		) {
			throw new Error(
				"Your organization needs an active Cap Pro subscription before adding the Signed BAA add-on.",
			);
		}
	}

	const { signatureDataUrl, ...contractFields } = details;
	const recordFields = { ...contractFields, signatureData: signatureDataUrl };

	const isEmailRetry = existing?.status === "active";
	const claimedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
	let recordId: string;
	if (existing) {
		recordId = existing.id;
		const staleBefore = new Date(Date.now() - PROCESSING_STALE_MS);
		const claim = await db()
			.update(signedBaas)
			.set({
				status: "processing",
				updatedAt: claimedAt,
				userId: user.id,
				...recordFields,
				// A stale ID from a canceled subscription would stop the
				// subscription.created webhook from associating the replacement.
				...(isEmailRetry
					? {}
					: {
							signedAt: null,
							emailSentAt: null,
							stripeSubscriptionId: paidSubscription?.id ?? null,
						}),
			})
			.where(
				and(
					eq(signedBaas.id, existing.id),
					eq(signedBaas.status, existing.status),
					existing.stripeSubscriptionId
						? eq(signedBaas.stripeSubscriptionId, existing.stripeSubscriptionId)
						: isNull(signedBaas.stripeSubscriptionId),
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
					updatedAt: claimedAt,
					...recordFields,
				});
		} catch {
			throw new Error(
				"A Signed BAA purchase is already in progress. Please wait a moment and refresh.",
			);
		}
	}

	const recordIdentity = { id: recordId, organizationId, userId: user.id };
	const revertToPending = async () => {
		// The subscription.created webhook can associate and activate the record
		// mid-flight when Stripe's create response was lost, so the revert must
		// only touch rows still claimed by this purchase attempt.
		let status = paidSubscription
			? "paid"
			: existing?.status === "canceled"
				? "canceled"
				: "pending";
		if (!paidSubscription) {
			const [current] = await db()
				.select({ subscriptionId: signedBaas.stripeSubscriptionId })
				.from(signedBaas)
				.where(eq(signedBaas.id, recordId))
				.limit(1);
			if (current?.subscriptionId) {
				try {
					const recovered = await stripe().subscriptions.retrieve(
						current.subscriptionId,
						{ expand: ["latest_invoice"] },
					);
					if (
						isSignedBaaSubscription(recovered) &&
						BAA_ENTITLED_STATUSES.has(recovered.status) &&
						hasPaidBaaInvoice(recovered)
					) {
						if (!(await ensureBaaHasPro(user, recovered, recordIdentity)))
							return;
						status = "paid";
					}
				} catch {
					return;
				}
			}
		}
		await db()
			.update(signedBaas)
			.set({ status })
			.where(
				and(
					eq(signedBaas.id, recordId),
					eq(signedBaas.status, "processing"),
					eq(signedBaas.updatedAt, claimedAt),
				),
			);
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

	let subscription: Stripe.Subscription | null = paidSubscription;
	if (!subscription) {
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
	}

	if (!subscription) {
		await revertToPending();
		throw new Error(
			"We couldn't confirm the Signed BAA subscription. Please try again or contact support if you were charged.",
		);
	}
	const association = await db()
		.update(signedBaas)
		.set({ stripeSubscriptionId: subscription.id, updatedAt: claimedAt })
		.where(
			and(
				eq(signedBaas.id, recordId),
				eq(signedBaas.status, "processing"),
				eq(signedBaas.updatedAt, claimedAt),
				or(
					isNull(signedBaas.stripeSubscriptionId),
					eq(signedBaas.stripeSubscriptionId, subscription.id),
				),
			),
		);
	const cancelIfUnlinked = async () => {
		const [current] = await db()
			.select()
			.from(signedBaas)
			.where(eq(signedBaas.id, recordId))
			.limit(1);
		if (
			!paidSubscription &&
			current?.stripeSubscriptionId !== subscription.id
		) {
			await stripe().subscriptions.cancel(subscription.id);
		}
		return current;
	};
	if (getAffectedRows(association) === 0) {
		const current = await cancelIfUnlinked();
		if (
			current?.stripeSubscriptionId !== subscription.id ||
			current.status !== "processing" ||
			current.updatedAt.getTime() !== claimedAt.getTime()
		) {
			throw new Error(
				"The BAA changed while confirming payment. Please refresh or contact support; do not pay again.",
			);
		}
	}
	if (!(await ensureBaaHasPro(user, subscription, recordIdentity))) {
		throw new Error(
			"Cap Pro ended before the BAA could be signed. The BAA subscription has been canceled; please contact support about your payment.",
		);
	}

	const finalized = await db()
		.update(signedBaas)
		.set({
			status: "active",
			stripeSubscriptionId: subscription.id,
			signedAt,
		})
		.where(
			and(
				eq(signedBaas.id, recordId),
				eq(signedBaas.status, "processing"),
				eq(signedBaas.updatedAt, claimedAt),
				eq(signedBaas.stripeSubscriptionId, subscription.id),
			),
		);
	if (getAffectedRows(finalized) === 0) {
		await cancelIfUnlinked();
		throw new Error(
			"The BAA changed while signing. Please refresh or contact support; do not pay again.",
		);
	}

	let emailSent = Boolean(existing?.emailSentAt);
	if (!emailSent) {
		try {
			const delivery = await sendEmail({
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
			if (!delivery?.data?.id || delivery.error) {
				throw new Error(
					delivery?.error?.message ??
						"The email provider did not confirm delivery.",
				);
			}
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
	revalidatePath("/dashboard/settings/organization/billing");

	return { success: true, emailSent };
}
