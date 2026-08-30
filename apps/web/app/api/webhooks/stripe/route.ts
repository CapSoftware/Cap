import { db } from "@cap/database";
import { sendEmail } from "@cap/database/emails/config";
import { PaymentFailed } from "@cap/database/emails/payment-failed";
import { nanoId } from "@cap/database/helpers";
import {
	developerCreditTransactions,
	signedBaas,
	users,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { stripe } from "@cap/utils";
import { Organisation, User } from "@cap/web-domain";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import type Stripe from "stripe";
import {
	attachPaidBaaCheckout,
	ensureBaaHasPro,
	hasPaidBaaInvoice,
	isSignedBaaPrice,
	isSignedBaaSubscription,
} from "@/lib/baa/billing";
import { addCreditsToAccount } from "@/lib/developer-credits";
import { trackServerEvent } from "@/lib/server-analytics";

const relevantEvents = new Set([
	"checkout.session.completed",
	"checkout.session.async_payment_succeeded",
	"customer.subscription.created",
	"customer.subscription.updated",
	"customer.subscription.deleted",
	"invoice.payment_failed",
]);

async function grantDeveloperCredits(
	session: Stripe.Checkout.Session,
): Promise<Response> {
	const { accountId, amountCents } = session.metadata ?? {};
	const paymentIntentId =
		typeof session.payment_intent === "string" ? session.payment_intent : null;

	if (!accountId || !amountCents || !paymentIntentId) {
		console.error("Missing required metadata for developer credits:", {
			accountId,
			amountCents,
			paymentIntentId,
		});
		return new Response("Missing metadata", { status: 400 });
	}

	// Only grant credits once the payment has actually settled. Without this
	// guard a checkout session (e.g. an unpaid/async payment) could grant
	// credits before money is captured.
	if (session.payment_status !== "paid") {
		console.log(
			`Developer credits checkout not paid yet (payment_status=${session.payment_status}); skipping credit grant`,
			{ accountId, paymentIntentId },
		);
		return NextResponse.json({ received: true });
	}

	console.log("Processing developer credits purchase:", {
		accountId,
		amountCents,
		paymentIntentId,
	});

	const [existingTxn] = await db()
		.select({ id: developerCreditTransactions.id })
		.from(developerCreditTransactions)
		.where(
			and(
				eq(developerCreditTransactions.accountId, accountId),
				eq(developerCreditTransactions.referenceId, paymentIntentId),
				eq(developerCreditTransactions.referenceType, "stripe_payment_intent"),
			),
		)
		.limit(1);

	if (existingTxn) {
		console.log(
			"Duplicate webhook delivery — transaction already exists:",
			existingTxn.id,
		);
		return NextResponse.json({ received: true });
	}

	await addCreditsToAccount({
		accountId,
		amountCents: Number(amountCents),
		referenceId: paymentIntentId,
		referenceType: "stripe_payment_intent",
		metadata: {
			amountCents: Number(amountCents),
			stripeSessionId: session.id,
		},
	});

	console.log("Developer credits added successfully");
	return NextResponse.json({ received: true });
}

const ENTITLED_SUBSCRIPTION_STATUSES = new Set([
	"active",
	"trialing",
	"past_due",
]);

// The Signed BAA add-on lives on its own subscription.
// It must never be treated as the Pro subscription: it would otherwise
// overwrite users.stripeSubscriptionId/Status and inflate the seat quota.
function hasEntitledProSubscription(subscriptions: Stripe.Subscription[]) {
	return subscriptions.some(
		(sub) =>
			!isSignedBaaSubscription(sub) &&
			ENTITLED_SUBSCRIPTION_STATUSES.has(sub.status),
	);
}

async function cancelEntitledBaaSubscriptions(
	subscriptions: Stripe.Subscription[],
	customerId: string,
) {
	const linked = await db()
		.select({ subscriptionId: signedBaas.stripeSubscriptionId })
		.from(signedBaas)
		.innerJoin(users, eq(signedBaas.userId, users.id))
		.where(
			and(
				eq(users.stripeCustomerId, customerId),
				ne(signedBaas.status, "canceled"),
			),
		)
		.limit(100);
	const allSubscriptions = [...subscriptions];
	for (const record of linked) {
		if (
			record.subscriptionId &&
			!allSubscriptions.some((sub) => sub.id === record.subscriptionId)
		) {
			const subscription = await stripe().subscriptions.retrieve(
				record.subscriptionId,
			);
			if (!isSignedBaaSubscription(subscription)) {
				throw new Error("Refusing to cancel a non-BAA subscription.");
			}
			allSubscriptions.push(subscription);
		}
	}
	// BAA terms end with the services agreement, so the add-on must stop
	// billing when no entitled Pro subscription remains.
	for (const sub of allSubscriptions) {
		if (!isSignedBaaSubscription(sub)) continue;
		if (ENTITLED_SUBSCRIPTION_STATUSES.has(sub.status)) {
			await stripe().subscriptions.cancel(sub.id);
		}
		await db()
			.update(signedBaas)
			.set({ status: "canceled" })
			.where(eq(signedBaas.stripeSubscriptionId, sub.id));
		console.log("Signed BAA subscription canceled alongside Pro", {
			subscriptionId: sub.id,
		});
	}
}

async function syncSignedBaaStatus(
	eventSubscription: Stripe.Subscription,
): Promise<Response> {
	const subscription = await stripe().subscriptions.retrieve(
		eventSubscription.id,
		{ expand: ["latest_invoice"] },
	);
	const entitled = ENTITLED_SUBSCRIPTION_STATUSES.has(subscription.status);
	const unsignedStatus = hasPaidBaaInvoice(subscription) ? "paid" : "pending";
	const organizationId = subscription.metadata?.organizationId
		? Organisation.OrganisationId.make(subscription.metadata.organizationId)
		: undefined;
	if (entitled) {
		await db()
			.update(signedBaas)
			.set({
				stripeSubscriptionId: subscription.id,
				updatedAt: sql`CASE WHEN ${signedBaas.status} = 'processing' THEN ${signedBaas.updatedAt} ELSE CURRENT_TIMESTAMP END`,
			})
			.where(
				and(
					ne(signedBaas.status, "canceled"),
					organizationId
						? or(
								eq(signedBaas.stripeSubscriptionId, subscription.id),
								and(
									eq(signedBaas.organizationId, organizationId),
									isNull(signedBaas.stripeSubscriptionId),
								),
							)
						: eq(signedBaas.stripeSubscriptionId, subscription.id),
				),
			);
		const records = await db()
			.select()
			.from(signedBaas)
			.where(eq(signedBaas.stripeSubscriptionId, subscription.id))
			.limit(2);
		if (records.length === 0) {
			return NextResponse.json({ received: true });
		}
		const [record] = records;
		if (records.length !== 1 || !record) {
			throw new Error("The BAA subscription is linked to multiple records.");
		}
		if (
			subscription.metadata?.userId &&
			subscription.metadata.userId !== record.userId
		) {
			throw new Error("The BAA subscription belongs to a different account.");
		}
		const [owner] = await db()
			.select({
				stripeCustomerId: users.stripeCustomerId,
				stripeSubscriptionId: users.stripeSubscriptionId,
			})
			.from(users)
			.where(eq(users.id, record.userId))
			.limit(1);
		if (!owner) {
			throw new Error("The BAA owner could not be found.");
		}
		if (!(await ensureBaaHasPro(owner, subscription, record.id))) {
			return NextResponse.json({ received: true });
		}
	}
	await db()
		.update(signedBaas)
		.set({
			status: entitled
				? sql`CASE
					WHEN ${signedBaas.status} = 'processing' THEN 'processing'
					WHEN ${signedBaas.signedAt} IS NOT NULL THEN 'active'
					WHEN ${signedBaas.status} = 'paid' THEN 'paid'
					ELSE ${unsignedStatus}
				END`
				: "canceled",
			stripeSubscriptionId: subscription.id,
			updatedAt: sql`CASE WHEN ${signedBaas.status} = 'processing' AND ${entitled} THEN ${signedBaas.updatedAt} ELSE CURRENT_TIMESTAMP END`,
		})
		.where(
			and(
				...(entitled ? [ne(signedBaas.status, "canceled")] : []),
				eq(signedBaas.stripeSubscriptionId, subscription.id),
			),
		);
	console.log("Signed BAA subscription synced", {
		subscriptionId: subscription.id,
		status: subscription.status,
	});
	return NextResponse.json({ received: true });
}

async function createGuestUser(
	email: string,
): Promise<typeof users.$inferSelect> {
	const userId = User.UserId.make(nanoId());

	await db()
		.insert(users)
		.values({
			id: userId,
			email: email,
			emailVerified: null,
			name: null,
			image: null,
			activeOrganizationId: Organisation.OrganisationId.make(""),
		});

	const result = await db()
		.select()
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	const newUser = result[0];
	if (!newUser) {
		throw new Error("Failed to create user");
	}

	return newUser;
}

async function findUserWithRetry(
	email: string,
	userId?: User.UserId,
	maxRetries = 3,
): Promise<typeof users.$inferSelect | null> {
	for (let i = 0; i < maxRetries; i++) {
		console.log(`[Attempt ${i + 1}/${maxRetries}] Looking for user:`, {
			email,
			userId,
		});

		try {
			if (userId) {
				console.log(`Attempting to find user by ID: ${userId}`);
				const userById = await db()
					.select()
					.from(users)
					.where(eq(users.id, userId))
					.limit(1)
					.then((rows) => rows[0] ?? null);

				if (userById) {
					console.log(`Found user by ID: ${userId}`);
					return userById;
				}
				console.log(`No user found by ID: ${userId}`);
			}

			if (email) {
				console.log(`Attempting to find user by email: ${email}`);
				const userByEmail = await db()
					.select()
					.from(users)
					.where(eq(users.email, email))
					.limit(1)
					.then((rows) => rows[0] ?? null);

				if (userByEmail) {
					console.log(`Found user by email: ${email}`);
					return userByEmail;
				}
				console.log(`No user found by email: ${email}`);
			}

			if (i < maxRetries - 1) {
				const delay = 2 ** i * 1000;
				console.log(
					`No user found on attempt ${
						i + 1
					}. Waiting ${delay}ms before retry...`,
				);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		} catch (error) {
			console.error(`Error during attempt ${i + 1}:`, error);
			if (i < maxRetries - 1) {
				const delay = 2 ** i * 1000;
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	}

	console.log("All attempts exhausted. No user found.");
	return null;
}

export const POST = async (req: Request) => {
	console.log("Webhook received");
	const buf = await req.text();
	const sig = req.headers.get("Stripe-Signature") as string;
	const webhookSecret = serverEnv().STRIPE_WEBHOOK_SECRET;
	let event: Stripe.Event;

	try {
		if (!sig || !webhookSecret) {
			console.log("❌ Missing webhook secret or signature");
			return new Response("Missing webhook secret or signature", {
				status: 400,
			});
		}
		event = stripe().webhooks.constructEvent(buf, sig, webhookSecret);
		console.log(`✅ Event received: ${event.type}`);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.log(`❌ Error message: ${message}`);
		return new Response(`Webhook Error: ${message}`, { status: 400 });
	}

	if (relevantEvents.has(event.type)) {
		try {
			let checkoutSubscription: Stripe.Subscription | undefined;
			if (
				event.type === "checkout.session.completed" ||
				event.type === "checkout.session.async_payment_succeeded"
			) {
				const session = event.data.object as Stripe.Checkout.Session;
				const subscriptionId =
					typeof session.subscription === "string"
						? session.subscription
						: session.subscription?.id;
				if (subscriptionId) {
					checkoutSubscription =
						await stripe().subscriptions.retrieve(subscriptionId);
					if (isSignedBaaSubscription(checkoutSubscription)) {
						const record = await attachPaidBaaCheckout(
							session,
							checkoutSubscription,
						);
						if (!record && session.payment_status === "paid") {
							console.error("Paid BAA checkout needs reconciliation", {
								sessionId: session.id,
								subscriptionId,
							});
						}
						return NextResponse.json({ received: true });
					}
				}
			}
			if (event.type === "checkout.session.completed") {
				console.log("Processing checkout.session.completed event");
				const session = event.data.object as Stripe.Checkout.Session;
				console.log("Session data:", {
					id: session.id,
					customerId: session.customer,
					subscriptionId: session.subscription,
				});

				if (session.metadata?.type === "developer_credits") {
					return await grantDeveloperCredits(session);
				}

				const customer = await stripe().customers.retrieve(
					session.customer as string,
				);
				console.log("Retrieved customer:", {
					id: customer.id,
					email: "email" in customer ? customer.email : undefined,
					metadata: "metadata" in customer ? customer.metadata : undefined,
				});

				let foundUserId: User.UserId | undefined;
				let customerEmail: string | null | undefined;

				if ("metadata" in customer) {
					foundUserId = customer.metadata.userId
						? User.UserId.make(customer.metadata.userId)
						: undefined;
				}
				if ("email" in customer) {
					customerEmail = customer.email;
				}

				console.log("Starting user lookup with:", {
					foundUserId,
					customerEmail,
				});

				let dbUser = await findUserWithRetry(
					customerEmail as string,
					foundUserId,
				);

				if (!dbUser && session.metadata?.guestCheckout === "true") {
					const guestEmail = customerEmail || session.customer_details?.email;

					if (!guestEmail) {
						console.error("No email found for guest checkout");
						return new Response("No email found for guest checkout", {
							status: 400,
						});
					}

					console.log(
						"Guest checkout detected, creating new user with email:",
						guestEmail,
					);
					try {
						dbUser = await createGuestUser(guestEmail);

						await stripe().customers.update(customer.id, {
							metadata: {
								...("metadata" in customer ? customer.metadata : {}),
								userId: dbUser.id,
							},
						});
					} catch (error) {
						console.error("Failed to create guest user:", error);
						return new Response("Failed to create user", { status: 500 });
					}
				}

				if (!dbUser) {
					console.log(
						"No user found after all retries. Returning 202 to allow retry.",
					);
					return new Response("User not found, webhook will be retried", {
						status: 202,
					});
				}

				console.log("Successfully found user:", {
					userId: dbUser.id,
					email: dbUser.email,
					name: dbUser.name,
				});

				const subscription =
					checkoutSubscription ??
					(await stripe().subscriptions.retrieve(
						session.subscription as string,
					));
				console.log("Retrieved subscription:", {
					id: subscription.id,
					status: subscription.status,
				});

				const inviteQuota = subscription.items.data.reduce(
					(total, item) => total + (item.quantity || 1),
					0,
				);
				const isOnBoarding = session.metadata?.isOnBoarding === "true";

				console.log("Updating user in database with:", {
					subscriptionId: session.subscription,
					status: subscription.status,
					customerId: customer.id,
					inviteQuota,
				});
				console.log("Session metadata:", session.metadata);
				console.log("Is onboarding:", isOnBoarding);

				await db()
					.update(users)
					.set({
						stripeSubscriptionId: session.subscription as string,
						stripeSubscriptionStatus: subscription.status,
						stripeCustomerId: customer.id,
						inviteQuota: inviteQuota,
						onboarding_completed_at: isOnBoarding ? new Date() : undefined,
					})
					.where(eq(users.id, dbUser.id));

				console.log("Successfully updated user in database");

				const isFirstPurchase = !dbUser.stripeSubscriptionId;
				const isGuestCheckout = session.metadata?.guestCheckout === "true";
				trackServerEvent(dbUser.id, "purchase_completed", {
					subscription_id: subscription.id,
					subscription_status: subscription.status,
					invite_quota: inviteQuota,
					price_id: subscription.items.data[0]?.price.id,
					quantity: inviteQuota,
					is_onboarding: session.metadata?.isOnBoarding === "true",
					platform:
						session.metadata?.platform === "desktop" ||
						session.metadata?.platform === "mobile" ||
						session.metadata?.platform === "web"
							? session.metadata.platform
							: "unknown",
					is_first_purchase: isFirstPurchase,
					is_guest_checkout: isGuestCheckout,
					// Joins guest funnels: guest_checkout_started fires on a throwaway
					// guest-<session id> profile, so this is the only shared key.
					session_id: session.id,
				});
			}

			if (event.type === "checkout.session.async_payment_succeeded") {
				console.log(
					"Processing checkout.session.async_payment_succeeded event",
				);
				const session = event.data.object as Stripe.Checkout.Session;

				if (session.metadata?.type === "developer_credits") {
					return await grantDeveloperCredits(session);
				}
			}

			if (event.type === "customer.subscription.created") {
				const subscription = event.data.object as Stripe.Subscription;
				// Recovers purchases whose create response was lost: the purchase
				// action may have reverted its record without a subscription ID, and
				// no updated event fires until the next subscription change, so the
				// creation event is the only reliable association signal.
				if (isSignedBaaSubscription(subscription)) {
					return await syncSignedBaaStatus(subscription);
				}
			}

			if (event.type === "customer.subscription.updated") {
				console.log("Processing customer.subscription.updated event");
				const subscription = event.data.object as Stripe.Subscription;
				console.log("Subscription data:", {
					id: subscription.id,
					status: subscription.status,
					customerId: subscription.customer,
				});

				if (isSignedBaaSubscription(subscription)) {
					return await syncSignedBaaStatus(subscription);
				}

				const customer = await stripe().customers.retrieve(
					subscription.customer as string,
				);
				console.log("Retrieved customer:", {
					id: customer.id,
					email: "email" in customer ? customer.email : undefined,
					metadata: "metadata" in customer ? customer.metadata : undefined,
				});

				let foundUserId: User.UserId | undefined;
				let customerEmail: string | null | undefined;

				if ("metadata" in customer) {
					foundUserId = customer.metadata.userId
						? User.UserId.make(customer.metadata.userId)
						: undefined;
				}
				if ("email" in customer) {
					customerEmail = customer.email;
				}

				console.log("Starting user lookup with:", {
					foundUserId,
					customerEmail,
				});

				const dbUser = await findUserWithRetry(
					customerEmail as string,
					foundUserId,
				);

				const subscriptions = await stripe().subscriptions.list({
					customer: customer.id,
					status: "all",
					limit: 100,
				});

				console.log("Retrieved all subscriptions:", {
					count: subscriptions.data.length,
				});

				// BAA cleanup depends only on Stripe state, so it must run even
				// when the customer cannot be mapped to a user; the 202 below is
				// treated as delivered and the event is never redelivered.
				if (!hasEntitledProSubscription(subscriptions.data)) {
					await cancelEntitledBaaSubscriptions(subscriptions.data, customer.id);
				}

				if (!dbUser) {
					console.log(
						"No user found after all retries. Returning 202 to allow retry.",
					);
					return new Response("User not found, webhook will be retried", {
						status: 202,
					});
				}

				console.log("Successfully found user:", {
					userId: dbUser.id,
					email: dbUser.email,
					name: dbUser.name,
				});

				// Quota follows entitlement: past_due keeps its seats during the
				// dunning window instead of collapsing the org to zero while
				// Stripe retries the card.
				const inviteQuota = subscriptions.data
					.filter(
						(sub) =>
							ENTITLED_SUBSCRIPTION_STATUSES.has(sub.status) &&
							!isSignedBaaSubscription(sub),
					)
					.reduce((total, sub) => {
						return (
							total +
							sub.items.data.reduce(
								(subTotal, item) => subTotal + (item.quantity || 1),
								0,
							)
						);
					}, 0);

				console.log("Updating user in database with:", {
					subscriptionId: subscription.id,
					status: subscription.status,
					customerId: customer.id,
					inviteQuota,
				});

				await db()
					.update(users)
					.set({
						stripeSubscriptionId: subscription.id,
						stripeSubscriptionStatus: subscription.status,
						stripeCustomerId: customer.id,
						inviteQuota: inviteQuota,
					})
					.where(eq(users.id, dbUser.id));

				console.log(
					"Successfully updated user in database with new invite quota:",
					inviteQuota,
				);
			}

			if (event.type === "invoice.payment_failed") {
				const invoice = event.data.object as Stripe.Invoice;
				console.log("Processing invoice.payment_failed event", {
					invoiceId: invoice.id,
					customerId: invoice.customer,
					billingReason: invoice.billing_reason,
					attemptCount: invoice.attempt_count,
					nextPaymentAttempt: invoice.next_payment_attempt,
				});

				// Checkout-time failures surface in the checkout UI itself; only
				// dun renewals and plan changes.
				if (
					invoice.billing_reason !== "subscription_cycle" &&
					invoice.billing_reason !== "subscription_update"
				) {
					return NextResponse.json({ received: true });
				}

				// Signed BAA renewals must not trigger the Cap Pro dunning email;
				// its status is tracked via customer.subscription.updated instead.
				if (
					invoice.subscription_details?.metadata?.type === "signed_baa" ||
					invoice.lines?.data.some((line) => isSignedBaaPrice(line.price?.id))
				) {
					return NextResponse.json({ received: true });
				}

				const finalAttempt = invoice.next_payment_attempt === null;
				// Email on the first failure and the final attempt only; the
				// retries in between would just be noise.
				if (invoice.attempt_count !== 1 && !finalAttempt) {
					return NextResponse.json({ received: true });
				}

				const customer = await stripe().customers.retrieve(
					invoice.customer as string,
				);

				let foundUserId: User.UserId | undefined;
				let customerEmail: string | null | undefined;
				if ("metadata" in customer) {
					foundUserId = customer.metadata.userId
						? User.UserId.make(customer.metadata.userId)
						: undefined;
				}
				if ("email" in customer) {
					customerEmail = customer.email;
				}

				const dbUser = await findUserWithRetry(
					customerEmail as string,
					foundUserId,
				);

				if (!dbUser?.email) {
					console.log(
						"No user found for failed invoice; skipping dunning email",
					);
					return NextResponse.json({ received: true });
				}

				const nextRetryDate = invoice.next_payment_attempt
					? new Date(invoice.next_payment_attempt * 1000).toLocaleDateString(
							"en-US",
							{ month: "long", day: "numeric" },
						)
					: null;

				await sendEmail({
					email: dbUser.email,
					subject: finalAttempt
						? "Last chance to keep your Cap Pro subscription"
						: "Your Cap Pro payment didn't go through",
					react: PaymentFailed({
						email: dbUser.email,
						billingUrl: `${serverEnv().WEB_URL}/dashboard/settings/organization`,
						nextRetryDate,
						finalAttempt,
					}),
					idempotencyKey: `payment-failed-${invoice.id}-${invoice.attempt_count}`,
				});

				console.log("Dunning email sent", {
					userId: dbUser.id,
					finalAttempt,
				});
			}

			if (event.type === "customer.subscription.deleted") {
				const subscription = event.data.object as Stripe.Subscription;

				if (isSignedBaaSubscription(subscription)) {
					return await syncSignedBaaStatus(subscription);
				}

				const customer = await stripe().customers.retrieve(
					subscription.customer as string,
				);

				// BAA cleanup depends only on Stripe state; it must run before the
				// user-mapping early returns so an unmappable customer can't keep
				// an active BAA billing after their last Pro subscription ends.
				const remainingSubscriptions = await stripe().subscriptions.list({
					customer: customer.id,
					status: "all",
					limit: 100,
				});
				if (!hasEntitledProSubscription(remainingSubscriptions.data)) {
					await cancelEntitledBaaSubscriptions(
						remainingSubscriptions.data,
						customer.id,
					);
				}

				let foundUserId: User.UserId | undefined;
				if ("metadata" in customer) {
					foundUserId = customer.metadata.userId
						? User.UserId.make(customer.metadata.userId)
						: undefined;
				}
				if (!foundUserId) {
					console.log("No user found in metadata, checking customer email");
					if ("email" in customer && customer.email) {
						const userByEmail = await db()
							.select()
							.from(users)
							.where(eq(users.email, customer.email))
							.limit(1);

						if (userByEmail && userByEmail.length > 0 && userByEmail[0]) {
							foundUserId = userByEmail[0].id;
							console.log(`User found by email: ${foundUserId}`);
							await stripe().customers.update(customer.id, {
								metadata: { userId: foundUserId },
							});
						} else {
							console.log("No user found by email");
							return new Response("No user found", {
								status: 400,
							});
						}
					} else {
						console.log("No email found for customer");
						return new Response("No user found", {
							status: 400,
						});
					}
				}

				const userResult = await db()
					.select()
					.from(users)
					.where(eq(users.id, foundUserId));

				if (!userResult || userResult.length === 0) {
					console.log("No user found in database");
					return new Response("No user found", { status: 400 });
				}

				await db()
					.update(users)
					.set({
						stripeSubscriptionId: subscription.id,
						stripeSubscriptionStatus: subscription.status,
						inviteQuota: 1,
					})
					.where(eq(users.id, foundUserId));

				console.log("User updated successfully", {
					foundUserId,
					inviteQuota: 1,
				});
			}

			return NextResponse.json({ received: true });
		} catch (error) {
			console.error("❌ Webhook handler failed:", error);
			return new Response(
				'Webhook error: "Webhook handler failed. View logs."',
				{
					status: 400,
				},
			);
		}
	}

	console.log(`Unrecognised event: ${event.type}`);
	return new Response(`Unrecognised event: ${event.type}`, { status: 400 });
};
