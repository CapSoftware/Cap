import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import { developerCreditTransactions, users } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { stripe } from "@cap/utils";
import { Organisation, User } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { queueServerProductEvent } from "@/lib/analytics/server";
import {
	isFirstPositiveSubscriptionPayment,
	isSettledSubscriptionPurchase,
	queueSubscriptionCheckoutProductEvent,
	queueSubscriptionTrialStartedProductEvent,
	subscriptionCancelledProductEvent,
	subscriptionChangedProductEvents,
	subscriptionInvoicePaidProductEvent,
	subscriptionPaymentFailedProductEvent,
	subscriptionRefundedProductEvent,
	subscriptionTrialConvertedProductEvent,
} from "@/lib/analytics/stripe-business-events";
import { addCreditsToAccount } from "@/lib/developer-credits";

const relevantEvents = new Set([
	"checkout.session.completed",
	"checkout.session.async_payment_succeeded",
	"charge.refunded",
	"invoice.paid",
	"invoice.payment_failed",
	"customer.subscription.created",
	"customer.subscription.updated",
	"customer.subscription.deleted",
]);

function retryableUserResolutionFailure() {
	return new Response("User identity is not available yet", {
		status: 503,
		headers: { "Retry-After": "60" },
	});
}

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
		console.log(`[Attempt ${i + 1}/${maxRetries}] Looking for Stripe user`);

		try {
			if (userId) {
				console.log("Attempting to find Stripe user by ID");
				const userById = await db()
					.select()
					.from(users)
					.where(eq(users.id, userId))
					.limit(1)
					.then((rows) => rows[0] ?? null);

				if (userById) {
					console.log("Found Stripe user by ID");
					return userById;
				}
				console.log("No Stripe user found by ID");
			}

			if (email) {
				console.log("Attempting to find Stripe user by email");
				const userByEmail = await db()
					.select()
					.from(users)
					.where(eq(users.email, email))
					.limit(1)
					.then((rows) => rows[0] ?? null);

				if (userByEmail) {
					console.log("Found Stripe user by email");
					return userByEmail;
				}
				console.log("No Stripe user found by email");
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

async function findAnalyticsUserForCustomer(
	customerId: string | Stripe.Customer | Stripe.DeletedCustomer | null,
) {
	if (!customerId) return null;
	const customer =
		typeof customerId === "string"
			? await stripe().customers.retrieve(customerId)
			: customerId;
	if (customer.deleted) return null;
	const userId = customer.metadata.userId
		? User.UserId.make(customer.metadata.userId)
		: undefined;
	return findUserWithRetry(customer.email ?? "", userId, 1);
}

async function chargeInvoice(charge: Stripe.Charge): Promise<Stripe.Invoice> {
	if (!charge.invoice) {
		throw new Error("Subscription refund is missing its Stripe invoice");
	}
	return typeof charge.invoice === "string"
		? stripe().invoices.retrieve(charge.invoice)
		: charge.invoice;
}

async function invoiceSubscription(invoice: Stripe.Invoice) {
	if (!invoice.subscription) {
		throw new Error("Subscription invoice is missing its subscription");
	}
	return typeof invoice.subscription === "string"
		? stripe().subscriptions.retrieve(invoice.subscription)
		: invoice.subscription;
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
			if (event.type === "invoice.paid") {
				const invoice = event.data.object as Stripe.Invoice;
				if (!invoice.subscription) return NextResponse.json({ received: true });
				const subscription = await invoiceSubscription(invoice);
				const dbUser = await findAnalyticsUserForCustomer(invoice.customer);
				if (!dbUser) return retryableUserResolutionFailure();
				const invoicePaidProductEvent = subscriptionInvoicePaidProductEvent({
					eventId: event.id,
					occurredAt: new Date(event.created * 1000).toISOString(),
					invoice,
					subscription,
					user: dbUser,
					firstPositivePayment: await isFirstPositiveSubscriptionPayment({
						invoice,
						subscriptionId: subscription.id,
						listPaidInvoices: (input) => stripe().invoices.list(input),
					}),
				});
				if (invoicePaidProductEvent)
					await queueServerProductEvent(invoicePaidProductEvent);
			}

			if (event.type === "invoice.payment_failed") {
				const invoice = event.data.object as Stripe.Invoice;
				if (invoice.subscription) {
					const subscription = await invoiceSubscription(invoice);
					const dbUser = await findAnalyticsUserForCustomer(invoice.customer);
					if (!dbUser) return retryableUserResolutionFailure();
					const paymentFailedProductEvent =
						subscriptionPaymentFailedProductEvent({
							eventId: event.id,
							occurredAt: new Date(event.created * 1000).toISOString(),
							invoice,
							subscription,
							user: dbUser,
						});
					if (paymentFailedProductEvent)
						await queueServerProductEvent(paymentFailedProductEvent);
				}
			}

			if (event.type === "charge.refunded") {
				const charge = event.data.object as Stripe.Charge;
				const previousCharge = event.data.previous_attributes as
					| Partial<Stripe.Charge>
					| undefined;
				const previousAmountRefunded = previousCharge?.amount_refunded ?? 0;
				const refundedAmount = charge.amount_refunded - previousAmountRefunded;
				if (charge.invoice && refundedAmount > 0) {
					const invoice = await chargeInvoice(charge);
					const subscription = await invoiceSubscription(invoice);
					const dbUser = await findAnalyticsUserForCustomer(charge.customer);
					if (!dbUser) return retryableUserResolutionFailure();
					const refundProductEvent = subscriptionRefundedProductEvent({
						eventId: event.id,
						occurredAt: new Date(event.created * 1000).toISOString(),
						charge,
						invoice,
						subscription,
						user: dbUser,
						refundedAmount,
					});
					if (refundProductEvent)
						await queueServerProductEvent(refundProductEvent);
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
				console.log("Retrieved Stripe customer");

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

				console.log("Starting Stripe user lookup");

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

					console.log("Guest checkout detected, creating new user");
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
					console.error("No user found after all checkout retries");
					return retryableUserResolutionFailure();
				}

				console.log("Successfully found Stripe user");

				const subscription = await stripe().subscriptions.retrieve(
					session.subscription as string,
				);
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

				if (isSettledSubscriptionPurchase(session)) {
					await queueSubscriptionCheckoutProductEvent({
						eventId: event.id,
						occurredAt: new Date(event.created * 1000).toISOString(),
						session,
						user: dbUser,
					});
				}
			}

			if (event.type === "checkout.session.async_payment_succeeded") {
				console.log(
					"Processing checkout.session.async_payment_succeeded event",
				);
				const session = event.data.object as Stripe.Checkout.Session;

				if (session.metadata?.type === "developer_credits") {
					return await grantDeveloperCredits(session);
				}

				if (typeof session.subscription === "string") {
					if (isSettledSubscriptionPurchase(session)) {
						let dbUser: typeof users.$inferSelect | null = null;
						if (typeof session.customer === "string") {
							const customer = await stripe().customers.retrieve(
								session.customer,
							);
							if (!customer.deleted) {
								const userId = customer.metadata.userId
									? User.UserId.make(customer.metadata.userId)
									: undefined;
								dbUser = await findUserWithRetry(
									customer.email ?? "",
									userId,
									1,
								);
							}
						}
						if (!dbUser) {
							console.error("No user found for settled asynchronous checkout");
							return retryableUserResolutionFailure();
						}

						await queueSubscriptionCheckoutProductEvent({
							eventId: event.id,
							occurredAt: new Date(event.created * 1000).toISOString(),
							session,
							user: dbUser,
						});
					}
				}
			}

			if (event.type === "customer.subscription.created") {
				const subscription = event.data.object as Stripe.Subscription;
				if (
					subscription.status === "trialing" &&
					subscription.metadata.analyticsSchemaVersion
				) {
					const customer = await stripe().customers.retrieve(
						subscription.customer as string,
					);
					if (customer.deleted) return retryableUserResolutionFailure();
					const userId = customer.metadata.userId
						? User.UserId.make(customer.metadata.userId)
						: undefined;
					const dbUser = await findUserWithRetry(
						customer.email ?? "",
						userId,
						1,
					);
					if (!dbUser) return retryableUserResolutionFailure();
					await queueSubscriptionTrialStartedProductEvent({
						eventId: event.id,
						occurredAt: new Date(event.created * 1_000).toISOString(),
						subscription,
						user: dbUser,
					});
				}
			}

			if (event.type === "customer.subscription.updated") {
				console.log("Processing customer.subscription.updated event");
				const subscription = event.data.object as Stripe.Subscription;
				const previous = event.data.previous_attributes as
					| Partial<Stripe.Subscription>
					| undefined;
				console.log("Subscription data:", {
					id: subscription.id,
					status: subscription.status,
					customerId: subscription.customer,
				});

				const customer = await stripe().customers.retrieve(
					subscription.customer as string,
				);
				console.log("Retrieved Stripe customer");

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

				console.log("Starting Stripe user lookup");

				const dbUser = await findUserWithRetry(
					customerEmail as string,
					foundUserId,
				);

				if (!dbUser) {
					console.error("No user found after all subscription retries");
					return retryableUserResolutionFailure();
				}

				console.log("Successfully found Stripe user");

				const subscriptions = await stripe().subscriptions.list({
					customer: customer.id,
					status: "active",
				});

				console.log("Retrieved all active subscriptions:", {
					count: subscriptions.data.length,
				});

				const inviteQuota = subscriptions.data.reduce((total, sub) => {
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

				const occurredAt = new Date(event.created * 1000).toISOString();
				const trialConverted = subscriptionTrialConvertedProductEvent({
					eventId: event.id,
					occurredAt,
					subscription,
					previousStatus: previous?.status,
					user: dbUser,
				});
				if (trialConverted) await queueServerProductEvent(trialConverted);
				for (const productEvent of subscriptionChangedProductEvents({
					eventId: event.id,
					occurredAt,
					subscription,
					previous,
					user: dbUser,
				})) {
					await queueServerProductEvent(productEvent);
				}

				console.log(
					"Successfully updated user in database with new invite quota:",
					inviteQuota,
				);
			}

			if (event.type === "customer.subscription.deleted") {
				const subscription = event.data.object as Stripe.Subscription;
				const customer = await stripe().customers.retrieve(
					subscription.customer as string,
				);
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
							console.log("Stripe user found by email");
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

				await queueServerProductEvent(
					subscriptionCancelledProductEvent({
						eventId: event.id,
						occurredAt: new Date(event.created * 1000).toISOString(),
						subscription,
						user: { id: foundUserId },
					}),
				);

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
