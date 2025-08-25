import * as crypto from "node:crypto";
import { db } from "@cap/database";
import { organizations, users } from "@cap/database/schema";
import { buildEnv, serverEnv } from "@cap/env";
import { stripe, userIsPro } from "@cap/utils";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { PostHog } from "posthog-node";
import { z } from "zod";
import { withAuth } from "../../utils";
import { createBucketProvider } from "@/utils/s3";
import { nanoId } from "@cap/database/helpers";

export const app = new Hono().use(withAuth);

app.post(
	"/feedback",
	zValidator(
		"form",
		z.object({
			feedback: z.string(),
			os: z.union([z.literal("macos"), z.literal("windows")]).optional(),
			version: z.string().optional(),
			systemInfo: z
				.object({
					os: z.string(),
					os_version: z.string(),
					arch: z.string(),
					cpu_cores: z.number(),
					memory_gb: z.number(),
					displays: z.array(
						z.object({
							width: z.number(),
							height: z.number(),
							scale_factor: z.number(),
						}),
					),
					cameras: z.array(z.string()),
					microphones: z.array(z.string()),
				})
				.optional(),
		}),
	),
	async (c) => {
		const { feedback, os, version, systemInfo } = c.req.valid("form");

		try {
			const discordWebhookUrl = serverEnv().DISCORD_FEEDBACK_WEBHOOK_URL;
			if (!discordWebhookUrl)
				throw new Error("Discord webhook URL is not configured");

			let messageContent = `New feedback from ${c.get("user").email}:\n${feedback}`;
			
			if (os && version) {
				messageContent += `\n${os} v${version}`;
			}
			
			const embeds = [];
			if (systemInfo) {
				embeds.push({
					title: "Device Information",
					color: 5814783,
					fields: [
						{
							name: "OS",
							value: `${systemInfo.os} ${systemInfo.os_version}`,
							inline: true,
						},
						{
							name: "Architecture",
							value: systemInfo.arch,
							inline: true,
						},
						{
							name: "CPU/Memory",
							value: `${systemInfo.cpu_cores} cores, ${systemInfo.memory_gb.toFixed(1)} GB`,
							inline: true,
						},
						{
							name: "Displays",
							value: systemInfo.displays.map(d => `${d.width}x${d.height}`).join(", "),
							inline: false,
						},
						{
							name: "Cameras",
							value: systemInfo.cameras.slice(0, 3).join("\n") || "None",
							inline: false,
						},
						{
							name: "Microphones",
							value: systemInfo.microphones.slice(0, 3).join("\n") || "None",
							inline: false,
						},
					],
				});
			}

			const response = await fetch(discordWebhookUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content: messageContent,
					embeds: embeds,
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
		} catch (error) {
			return c.json({ error: "Failed to submit feedback" }, { status: 500 });
		}
	},
);

app.post(
	"/recording",
	zValidator(
		"json",
		z.object({
			systemInfo: z.object({
				os: z.string(),
				os_version: z.string(),
				arch: z.string(),
				cpu_cores: z.number(),
				memory_gb: z.number(),
				displays: z.array(
					z.object({
						width: z.number(),
						height: z.number(),
						scale_factor: z.number(),
					}),
				),
				cameras: z.array(z.string()),
				microphones: z.array(z.string()),
			}),
			appVersion: z.string(),
			recording: z.object({
				name: z.string(),
				content: z.string(),
				size_mb: z.number(),
			}),
		}),
	),
	async (c) => {
		const { systemInfo, appVersion, recording } = c.req.valid("json");
		const user = c.get("user");

		try {
			const bucket = await createBucketProvider();
			const timestamp = new Date().toISOString().split('T')[0];
			const recordingKey = `debug-recordings/${user.id}/${timestamp}-${nanoId()}.zip`;
			
			const buffer = Buffer.from(recording.content, "base64");
			
			await bucket.putObject(recordingKey, buffer, {
				contentType: "application/zip",
			});
			
			const downloadUrl = await bucket.getSignedObjectUrl(recordingKey);
			
			const discordWebhookUrl = serverEnv().DISCORD_FEEDBACK_WEBHOOK_URL;
			if (!discordWebhookUrl)
				throw new Error("Discord webhook URL is not configured");

			const formattedMessage = {
				content: `📹 **Recording Submission from ${user.email}**`,
				embeds: [
					{
						title: "Recording Details",
						color: 5814783,
						fields: [
							{
								name: "File",
								value: recording.name,
								inline: true,
							},
							{
								name: "Size",
								value: `${recording.size_mb.toFixed(2)} MB`,
								inline: true,
							},
							{
								name: "App Version",
								value: appVersion,
								inline: true,
							},
							{
								name: "OS",
								value: `${systemInfo.os} ${systemInfo.os_version}`,
								inline: true,
							},
							{
								name: "Architecture",
								value: systemInfo.arch,
								inline: true,
							},
							{
								name: "Hardware",
								value: `${systemInfo.cpu_cores} cores, ${systemInfo.memory_gb.toFixed(1)} GB RAM`,
								inline: true,
							},
							{
								name: "Download Link",
								value: `[Download Recording (valid for 7 days)](${downloadUrl})`,
								inline: false,
							},
						],
					},
				],
			};
			
			const response = await fetch(discordWebhookUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(formattedMessage),
			});

			if (!response.ok)
				throw new Error(
					`Failed to send notification to Discord: ${response.statusText}`,
				);

			return c.json({
				success: true,
				message: "Recording uploaded successfully",
			});
		} catch (error) {
			console.error("Error submitting recording:", error);
			return c.json({ error: "Failed to submit recording" }, { status: 500 });
		}
	},
);

app.post(
	"/logs",
	zValidator(
		"json",
		z.object({
			systemInfo: z.object({
				os: z.string(),
				os_version: z.string(),
				arch: z.string(),
				cpu_cores: z.number(),
				memory_gb: z.number(),
				displays: z.array(
					z.object({
						width: z.number(),
						height: z.number(),
						scale_factor: z.number(),
					}),
				),
				cameras: z.array(z.string()),
				microphones: z.array(z.string()),
			}),
			recentLogs: z.array(
				z.object({
					id: z.string(),
					timestamp: z.string(),
					duration_seconds: z.number().nullable(),
					error: z.string().nullable(),
					log_content: z.string().nullable(),
					log_file_path: z.string().nullable().optional(),
				}),
			),
			appVersion: z.string(),
			logFiles: z
				.array(
					z.object({
						name: z.string(),
						content: z.string(),
					}),
				)
				.optional(),
		}),
	),
	async (c) => {
		const { systemInfo, recentLogs, appVersion, logFiles } = c.req.valid("json");

		try {
			const discordWebhookUrl = serverEnv().DISCORD_FEEDBACK_WEBHOOK_URL;
			if (!discordWebhookUrl)
				throw new Error("Discord webhook URL is not configured");

			const formattedMessage = {
				content: `🔧 **Logs Report from ${c.get("user").email}**`,
				embeds: [
					{
						title: "System Information",
						color: 5814783,
						fields: [
							{
								name: "OS",
								value: `${systemInfo.os} ${systemInfo.os_version}`,
								inline: true,
							},
							{
								name: "Architecture",
								value: systemInfo.arch,
								inline: true,
							},
							{
								name: "App Version",
								value: appVersion,
								inline: true,
							},
							{
								name: "CPU Cores",
								value: systemInfo.cpu_cores.toString(),
								inline: true,
							},
							{
								name: "Memory",
								value: `${systemInfo.memory_gb.toFixed(1)} GB`,
								inline: true,
							},
							{
								name: "Displays",
								value: systemInfo.displays
									.map((d) => `${d.width}x${d.height}`)
									.join(", "),
								inline: false,
							},
							{
								name: "Cameras",
								value:
									systemInfo.cameras.slice(0, 3).join("\n") || "None detected",
								inline: false,
							},
							{
								name: "Microphones",
								value:
									systemInfo.microphones.slice(0, 3).join("\n") ||
									"None detected",
								inline: false,
							},
						],
					},
				] as Array<{
					title: string;
					color: number;
					fields?: {
						name: string;
						value: string;
						inline: boolean;
					}[];
					description?: string;
				}>,
			};


			if (logFiles && logFiles.length > 0) {
				const formData = new FormData();
				
				formData.append("payload_json", JSON.stringify(formattedMessage));
				
				logFiles.forEach((file, index) => {
					const buffer = Buffer.from(file.content, "base64");
					const blob = new Blob([buffer], { type: "text/plain" });
					formData.append(`files[${index}]`, blob, file.name);
				});
				
				const response = await fetch(discordWebhookUrl, {
					method: "POST",
					body: formData,
				});
				
				if (!response.ok)
					throw new Error(
						`Failed to send logs to Discord: ${response.statusText}`,
					);
			} else {
				const response = await fetch(discordWebhookUrl, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(formattedMessage),
				});

				if (!response.ok)
					throw new Error(
						`Failed to send logs to Discord: ${response.statusText}`,
					);
			}

			return c.json({
				success: true,
				message: "Logs submitted successfully",
			});
		} catch (error) {
			return c.json({ error: "Failed to submit logs" }, { status: 500 });
		}
	},
);

app.get("/org-custom-domain", async (c) => {
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

app.get("/plan", async (c) => {
	const user = c.get("user");

	let isSubscribed = userIsPro(user);

	if (user.thirdPartyStripeSubscriptionId) {
		isSubscribed = true;
	}

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

app.post(
	"/subscribe",
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
			console.log("[POST] Creating new Stripe customer");
			const customer = await stripe().customers.create({
				email: user.email,
				metadata: { userId: user.id },
			});

			await db()
				.update(users)
				.set({ stripeCustomerId: customer.id })
				.where(eq(users.id, user.id));

			customerId = customer.id;
			console.log("[POST] Created Stripe customer:", customerId);
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
