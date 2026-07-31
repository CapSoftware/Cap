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
import { addCreditsToAccount } from "@/lib/developer-credits";

const relevantEvents = new Set([
	"checkout.session.completed",
	"checkout.session.async_payment_succeeded",
	"charge.refunded",
	"invoice.paid",
	"invoice.payment_failed",
	"customer.subscription.updated",
	"customer.subscription.deleted",
]);

type PurchaseAnalyticsUser = Pick<
	typeof users.$inferSelect,
	"id" | "activeOrganizationId"
>;

function isSettledSubscriptionPurchase(
	session: Stripe.Checkout.Session,
	subscription: Stripe.Subscription,
) {
	return (
		session.payment_status === "paid" &&
		(subscription.status === "active" || subscription.status === "trialing")
	);
}

function isStartedSubscriptionTrial(
	session: Stripe.Checkout.Session,
	subscription: Stripe.Subscription,
) {
	return (
		session.payment_status === "no_payment_required" &&
		subscription.status === "trialing"
	);
}

async function queueSubscriptionPurchaseEvents({
	eventId,
	occurredAt,
	session,
	subscription,
	inviteQuota,
	user,
	isFirstPurchase,
}: {
	eventId: string;
	occurredAt: string;
	session: Stripe.Checkout.Session;
	subscription: Stripe.Subscription;
	inviteQuota: number;
	user?: PurchaseAnalyticsUser;
	isFirstPurchase: boolean;
}) {
	const isGuestCheckout = session.metadata?.guestCheckout === "true";
	const platform =
		session.metadata?.platform === "desktop"
			? "desktop"
			: session.metadata?.platform === "mobile"
				? "mobile"
				: session.metadata?.platform === "web"
					? "web"
					: "server";
	const anonymousId = session.metadata?.analyticsAnonymousId;
	const price = subscription.items.data[0]?.price;
	if (isStartedSubscriptionTrial(session, subscription)) {
		await queueServerProductEvent({
			eventId: `stripe:${eventId}:trial_started`,
			eventName: "trial_started",
			occurredAt,
			anonymousId,
			platform,
			userId: user?.id,
			organizationId: user?.activeOrganizationId,
			properties: {
				subscription_status: "trialing",
				trial_end_at: subscription.trial_end ?? null,
				price_id: price?.id ?? null,
				quantity: inviteQuota,
				currency: price?.currency ?? null,
				unit_amount_minor: price?.unit_amount ?? null,
				billing_interval: price?.recurring?.interval ?? null,
				billing_interval_count: price?.recurring?.interval_count ?? null,
				is_guest_checkout: isGuestCheckout,
				is_onboarding: session.metadata?.isOnBoarding === "true",
			},
		});
		return;
	}

	const revenueProperties = {
		payment_status: "paid" as const,
		subscription_status: subscription.status,
		amount_total_minor: session.amount_total,
		amount_subtotal_minor: session.amount_subtotal,
		discount_amount_minor: session.total_details?.amount_discount,
		currency: session.currency,
		unit_amount_minor: price?.unit_amount,
		billing_interval: price?.recurring?.interval,
		billing_interval_count: price?.recurring?.interval_count,
	};

	await queueServerProductEvent({
		eventId: `stripe:${eventId}:purchase_completed`,
		eventName: "purchase_completed",
		occurredAt,
		anonymousId,
		platform,
		userId: user?.id,
		organizationId: user?.activeOrganizationId,
		properties: {
			...revenueProperties,
			invite_quota: inviteQuota,
			price_id: price?.id,
			quantity: inviteQuota,
			is_onboarding: session.metadata?.isOnBoarding === "true",
			is_first_purchase: isFirstPurchase,
			is_guest_checkout: isGuestCheckout,
		},
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
				if (
					invoice.subscription &&
					invoice.billing_reason === "subscription_cycle"
				) {
					const dbUser = await findAnalyticsUserForCustomer(invoice.customer);
					await queueServerProductEvent({
						eventId: `stripe:${event.id}:subscription_renewed`,
						eventName: "subscription_renewed",
						occurredAt: new Date(event.created * 1000).toISOString(),
						platform: "server",
						userId: dbUser?.id,
						organizationId: dbUser?.activeOrganizationId,
						properties: {
							amount_paid_minor: invoice.amount_paid,
							currency: invoice.currency,
							billing_reason: "subscription_cycle",
						},
					});
				}
			}

			if (event.type === "invoice.payment_failed") {
				const invoice = event.data.object as Stripe.Invoice;
				if (invoice.subscription) {
					const dbUser = await findAnalyticsUserForCustomer(invoice.customer);
					await queueServerProductEvent({
						eventId: `stripe:${event.id}:subscription_payment_failed`,
						eventName: "subscription_payment_failed",
						occurredAt: new Date(event.created * 1000).toISOString(),
						platform: "server",
						userId: dbUser?.id,
						organizationId: dbUser?.activeOrganizationId,
						properties: {
							amount_due_minor: invoice.amount_due,
							currency: invoice.currency,
							attempt_count: invoice.attempt_count,
						},
					});
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
					const dbUser = await findAnalyticsUserForCustomer(charge.customer);
					await queueServerProductEvent({
						eventId: `stripe:${event.id}:subscription_refunded`,
						eventName: "subscription_refunded",
						occurredAt: new Date(event.created * 1000).toISOString(),
						platform: "server",
						userId: dbUser?.id,
						organizationId: dbUser?.activeOrganizationId,
						properties: {
							amount_refunded_minor: refundedAmount,
							currency: charge.currency,
							fully_refunded: charge.refunded,
						},
					});
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

				if (
					isSettledSubscriptionPurchase(session, subscription) ||
					isStartedSubscriptionTrial(session, subscription)
				) {
					await queueSubscriptionPurchaseEvents({
						eventId: event.id,
						occurredAt: new Date(event.created * 1000).toISOString(),
						session,
						subscription,
						inviteQuota,
						user: dbUser,
						isFirstPurchase:
							session.metadata?.analyticsIsFirstPurchase === "true",
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
					const subscription = await stripe().subscriptions.retrieve(
						session.subscription,
					);
					if (
						isSettledSubscriptionPurchase(session, subscription) ||
						isStartedSubscriptionTrial(session, subscription)
					) {
						const inviteQuota = subscription.items.data.reduce(
							(total, item) => total + (item.quantity || 1),
							0,
						);
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

						await queueSubscriptionPurchaseEvents({
							eventId: event.id,
							occurredAt: new Date(event.created * 1000).toISOString(),
							session,
							subscription,
							inviteQuota,
							...(dbUser ? { user: dbUser } : {}),
							isFirstPurchase:
								session.metadata?.analyticsIsFirstPurchase === "true",
						});
					}
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

				if (
					previous?.status === "trialing" &&
					subscription.status === "active"
				) {
					await queueServerProductEvent({
						eventId: `stripe:${event.id}:trial_converted`,
						eventName: "trial_converted",
						occurredAt: new Date(event.created * 1000).toISOString(),
						platform: "server",
						userId: dbUser.id,
						organizationId: dbUser.activeOrganizationId,
						properties: {
							previous_status: "trialing",
							new_status: "active",
						},
					});
				}

				if (
					previous?.cancel_at_period_end !== undefined &&
					previous.cancel_at_period_end !== subscription.cancel_at_period_end
				) {
					await queueServerProductEvent({
						eventId: `stripe:${event.id}:subscription_changed:cancellation`,
						eventName: "subscription_changed",
						occurredAt: new Date(event.created * 1000).toISOString(),
						platform: "server",
						userId: dbUser.id,
						organizationId: dbUser.activeOrganizationId,
						properties: {
							change_kind: subscription.cancel_at_period_end
								? "cancellation_scheduled"
								: "cancellation_reversed",
							previous_status: previous.status ?? null,
							new_status: subscription.status,
							previous_price_id: null,
							new_price_id: null,
							previous_quantity: null,
							new_quantity: null,
						},
					});
				}

				if (previous?.status && previous.status !== subscription.status) {
					await queueServerProductEvent({
						eventId: `stripe:${event.id}:subscription_changed:status`,
						eventName: "subscription_changed",
						occurredAt: new Date(event.created * 1000).toISOString(),
						platform: "server",
						userId: dbUser.id,
						organizationId: dbUser.activeOrganizationId,
						properties: {
							change_kind: "status",
							previous_status: previous.status,
							new_status: subscription.status,
							previous_price_id: null,
							new_price_id: null,
							previous_quantity: null,
							new_quantity: null,
						},
					});
				}

				const previousItem = previous?.items?.data[0];
				const currentItem = subscription.items.data[0];
				if (
					previousItem &&
					currentItem &&
					previousItem.price.id !== currentItem.price.id
				) {
					await queueServerProductEvent({
						eventId: `stripe:${event.id}:subscription_changed:plan`,
						eventName: "subscription_changed",
						occurredAt: new Date(event.created * 1000).toISOString(),
						platform: "server",
						userId: dbUser.id,
						organizationId: dbUser.activeOrganizationId,
						properties: {
							change_kind: "plan",
							previous_status: null,
							new_status: null,
							previous_price_id: previousItem.price.id,
							new_price_id: currentItem.price.id,
							previous_quantity: previousItem.quantity,
							new_quantity: currentItem.quantity,
						},
					});
				} else if (
					previousItem &&
					currentItem &&
					previousItem.quantity !== currentItem.quantity
				) {
					await queueServerProductEvent({
						eventId: `stripe:${event.id}:subscription_changed:seats`,
						eventName: "subscription_changed",
						occurredAt: new Date(event.created * 1000).toISOString(),
						platform: "server",
						userId: dbUser.id,
						organizationId: dbUser.activeOrganizationId,
						properties: {
							change_kind: "seats",
							previous_status: null,
							new_status: null,
							previous_price_id: previousItem.price.id,
							new_price_id: currentItem.price.id,
							previous_quantity: previousItem.quantity,
							new_quantity: currentItem.quantity,
						},
					});
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

				await queueServerProductEvent({
					eventId: `stripe:${event.id}:subscription_cancelled`,
					eventName: "subscription_cancelled",
					occurredAt: new Date(event.created * 1000).toISOString(),
					platform: "server",
					userId: foundUserId,
					organizationId: userResult[0]?.activeOrganizationId,
					properties: {
						status: subscription.status,
						ended_at: subscription.ended_at,
						cancel_at_period_end: subscription.cancel_at_period_end,
					},
				});

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
