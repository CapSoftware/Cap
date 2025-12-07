import * as crypto from "node:crypto";
import { db } from "@cap/database";
import {
	organizationMembers,
	organizations,
	users,
} from "@cap/database/schema";
import { buildEnv, serverEnv } from "@cap/env";
import { stripe, userIsPro } from "@cap/utils";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull, or } from "drizzle-orm";
import { Hono } from "hono";
import { PostHog } from "posthog-node";
import type Stripe from "stripe";
import { z } from "zod";
import { withAuth, withOptionalAuth } from "../../utils";

export const app = new Hono();

app.post(
	"/logs",
	zValidator(
		"form",
		z.object({
			log: z.string(),
			os: z.string().optional(),
			version: z.string().optional(),
		}),
	),
	withOptionalAuth,
	async (c) => {
		const { log, os, version } = c.req.valid("form");
		const user = c.get("user");

		try {
			const discordWebhookUrl = serverEnv().DISCORD_LOGS_WEBHOOK_URL;
			if (!discordWebhookUrl)
				throw new Error("Discord webhook URL is not configured");

			const formData = new FormData();
			const logBlob = new Blob([log], { type: "text/plain" });
			const fileName = `cap-desktop-${os || "unknown"}-${version || "unknown"}-${Date.now()}.log`;
			formData.append("file", logBlob, fileName);

			const content = [
				"New log file uploaded",
				user && `User: ${user.email} (${user.id})`,
				os && `OS: ${os}`,
				version && `Version: ${version}`,
			]
				.filter(Boolean)
				.join("\n");

			formData.append("content", content);

			const response = await fetch(discordWebhookUrl, {
				method: "POST",
				body: formData,
			});

			if (!response.ok)
				throw new Error(
					`Failed to send logs to Discord: ${response.statusText}`,
				);

			return c.json({
				success: true,
				message: "Logs uploaded successfully",
			});
		} catch (_error) {
			return c.json({ error: "Failed to upload logs" }, { status: 500 });
		}
	},
);

app.post(
	"/feedback",
	withAuth,
	zValidator(
		"form",
		z.object({
			feedback: z.string(),
			os: z.union([z.literal("macos"), z.literal("windows")]).optional(),
			version: z.string().optional(),
		}),
	),
	async (c) => {
		const { feedback, os, version } = c.req.valid("form");

		try {
			const discordWebhookUrl = serverEnv().DISCORD_FEEDBACK_WEBHOOK_URL;
			if (!discordWebhookUrl)
				throw new Error("Discord webhook URL is not configured");

			const response = await fetch(discordWebhookUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content: [
						`New feedback from ${c.get("user").email}:`,
						feedback,
						os && version && `${os} v${version}`,
					]
						.filter(Boolean)
						.join("\n"),
				}),
			});

			if (!response.ok)
				throw new Error(
					`Failed to send feedback to Discord: ${response.statusText}`,
				);

			return c.json({
				success: true,
				message: "Feedback submitted successfully",
			});
		} catch (_error) {
			return c.json({ error: "Failed to submit feedback" }, { status: 500 });
		}
	},
);

app.get("/org-custom-domain", withAuth, async (c) => {
	const user = c.get("user");

	try {
		const [result] = await db()
			.select({
				customDomain: organizations.customDomain,
				domainVerified: organizations.domainVerified,
			})
			.from(users)
			.leftJoin(organizations, eq(users.activeOrganizationId, organizations.id))
			.where(eq(users.id, user.id));

		let customDomain = result?.customDomain ?? null;
		if (
			customDomain &&
			!customDomain.startsWith("http://") &&
			!customDomain.startsWith("https://")
		) {
			customDomain = `https://${customDomain}`;
		}

		return c.json({
			custom_domain: customDomain,
			domain_verified: result?.domainVerified ?? null,
		});
	} catch (error) {
		console.error("[GET] Error fetching custom domain:", error);
		return c.json({ error: "Failed to fetch custom domain" }, { status: 500 });
	}
});

app.get("/plan", withAuth, async (c) => {
	const user = c.get("user");

	let isSubscribed = userIsPro(user);

	if (!isSubscribed && !user.stripeSubscriptionId && user.stripeCustomerId) {
		try {
			const subscriptions = await stripe().subscriptions.list({
				customer: user.stripeCustomerId,
			});
			const activeSubscription = subscriptions.data.find(
				(sub) => sub.status === "active",
			);
			if (activeSubscription) {
				isSubscribed = true;
				await db()
					.update(users)
					.set({
						stripeSubscriptionStatus: activeSubscription.status,
						stripeSubscriptionId: activeSubscription.id,
					})
					.where(eq(users.id, user.id));
			}
		} catch (error) {
			console.error("[GET] Error fetching subscription from Stripe:", error);
		}
	}

	let intercomHash = "";
	const intercomSecret = serverEnv().INTERCOM_SECRET;
	if (intercomSecret) {
		intercomHash = crypto
			.createHmac("sha256", intercomSecret)
			.update(user?.id ?? "")
			.digest("hex");
	}

	return c.json({
		upgraded: isSubscribed,
		stripeSubscriptionStatus: user.stripeSubscriptionStatus,
		intercomHash: intercomHash,
	});
});

app.get("/organizations", withAuth, async (c) => {
	const user = c.get("user");

	const orgs = await db()
		.select({
			id: organizations.id,
			name: organizations.name,
			ownerId: organizations.ownerId,
		})
		.from(organizations)
		.leftJoin(
			organizationMembers,
			eq(organizations.id, organizationMembers.organizationId),
		)
		.where(
			and(
				isNull(organizations.tombstoneAt),
				or(
					eq(organizations.ownerId, user.id),
					eq(organizationMembers.userId, user.id),
				),
			),
		)
		.groupBy(organizations.id);

	return c.json(orgs);
});

app.post(
	"/subscribe",
	withAuth,
	zValidator("json", z.object({ priceId: z.string() })),
	async (c) => {
		const { priceId } = c.req.valid("json");
		const user = c.get("user");

		if (userIsPro(user)) {
			console.log("[POST] Error: User already on Pro plan");
			return c.json({ error: true, subscription: true }, { status: 400 });
		}

		let customerId = user.stripeCustomerId;

		if (user.stripeCustomerId === null) {
			console.log(
				"[POST] Checking for existing Stripe customer for email:",
				user.email,
			);

			const existingCustomers = await stripe().customers.list({
				email: user.email,
				limit: 1,
			});

			let customer: Stripe.Customer;
			if (existingCustomers.data.length > 0 && existingCustomers.data[0]) {
				customer = existingCustomers.data[0];
				console.log("[POST] Found existing Stripe customer:", customer.id);

				customer = await stripe().customers.update(customer.id, {
					metadata: {
						...customer.metadata,
						userId: user.id,
					},
				});
				console.log("[POST] Updated existing customer metadata with userId");
			} else {
				console.log("[POST] Creating new Stripe customer");
				customer = await stripe().customers.create({
					email: user.email,
					metadata: { userId: user.id },
				});
				console.log("[POST] Created Stripe customer:", customer.id);
			}

			await db()
				.update(users)
				.set({ stripeCustomerId: customer.id })
				.where(eq(users.id, user.id));

			customerId = customer.id;
		}

		console.log("[POST] Creating checkout session");
		const checkoutSession = await stripe().checkout.sessions.create({
			customer: customerId as string,
			line_items: [{ price: priceId, quantity: 1 }],
			mode: "subscription",
			success_url: `${serverEnv().WEB_URL}/dashboard/caps?upgrade=true`,
			cancel_url: `${serverEnv().WEB_URL}/pricing`,
			allow_promotion_codes: true,
			metadata: { platform: "desktop", dubCustomerId: user.id },
		});

		if (checkoutSession.url) {
			console.log("[POST] Checkout session created successfully");

			try {
				const ph = new PostHog(buildEnv.NEXT_PUBLIC_POSTHOG_KEY || "", {
					host: buildEnv.NEXT_PUBLIC_POSTHOG_HOST || "",
				});

				ph.capture({
					distinctId: user.id,
					event: "checkout_started",
					properties: {
						price_id: priceId,
						quantity: 1,
						platform: "desktop",
					},
				});

				await ph.shutdown();
			} catch (e) {
				console.error("Failed to capture checkout_started in PostHog", e);
			}

			return c.json({ url: checkoutSession.url });
		}

		console.log("[POST] Error: Failed to create checkout session");
		return c.json({ error: true }, { status: 400 });
	},
);
