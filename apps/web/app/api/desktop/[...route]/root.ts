import { db } from "@cap/database";
import { sendEmail } from "@cap/database/emails/config";
import { Feedback } from "@cap/database/emails/feedback";
import {
	organizationMembers,
	organizations,
	users,
} from "@cap/database/schema";
import { buildEnv, serverEnv } from "@cap/env";
import { stripe, userIsPro } from "@cap/utils";
import { OrganizationBrandingPatchBody } from "@cap/web-api-contract";
import { ImageUploads } from "@cap/web-backend";
import { type ImageUpload, Organisation } from "@cap/web-domain";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull, or } from "drizzle-orm";
import { Effect, Option } from "effect";
import { Hono } from "hono";
import { PostHog } from "posthog-node";
import type Stripe from "stripe";
import { z } from "zod";
import { runPromise } from "@/lib/server";
import { withAuth, withOptionalAuth } from "../../utils";
import {
	canEditOrganizationBranding,
	type DesktopOrganizationRow,
	decodeOrganizationLogoUpdate,
	filterAccessibleOrganizationRows,
	mergeOrganizationBrandingMetadata,
	normalizeOrganizationBrandingPatchBody,
	OrganizationBrandingValidationError,
	toDesktopOrganization,
} from "./organization-branding";

export const app = new Hono();

async function resolveOrganizationIconUrl(iconUrl: string | null) {
	if (!iconUrl) return null;

	return Effect.gen(function* () {
		const imageUploads = yield* ImageUploads;
		return yield* imageUploads.resolveImageUrl(
			iconUrl as ImageUpload.ImageUrlOrKey,
		);
	}).pipe(runPromise);
}

async function toDesktopOrganizations(
	rows: DesktopOrganizationRow[],
	userId: string,
) {
	return Promise.all(
		filterAccessibleOrganizationRows(rows, userId).map(async (row) =>
			toDesktopOrganization(
				row,
				userId,
				await resolveOrganizationIconUrl(row.iconUrl),
			),
		),
	);
}

async function applyOrganizationLogoUpdate(
	row: DesktopOrganizationRow,
	logo: ReturnType<typeof decodeOrganizationLogoUpdate>,
) {
	if (logo.action === "keep") return;

	await Effect.gen(function* () {
		const imageUploads = yield* ImageUploads;

		yield* imageUploads.applyUpdate({
			payload:
				logo.action === "remove"
					? Option.none()
					: Option.some({
							contentType: logo.contentType,
							fileName: logo.fileName,
							data: logo.data,
						}),
			existing: Option.fromNullable(
				row.iconUrl as ImageUpload.ImageUrlOrKey | null,
			),
			keyPrefix: `organizations/${row.id}`,
			update: (db, urlOrKey) =>
				db
					.update(organizations)
					.set({ iconUrl: urlOrKey })
					.where(
						eq(organizations.id, Organisation.OrganisationId.make(row.id)),
					),
		});
	}).pipe(runPromise);
}

const diagnosticsSchema = z.object({
	system: z
		.object({
			windowsVersion: z
				.object({
					displayName: z.string(),
					meetsRequirements: z.boolean().optional(),
					isWindows11: z.boolean().optional(),
				})
				.optional(),
			macosVersion: z.object({ displayName: z.string() }).optional(),
			gpuInfo: z
				.object({
					vendor: z.string(),
					description: z.string(),
					dedicatedVideoMemoryMb: z.number().optional(),
					isSoftwareAdapter: z.boolean().optional(),
					isBasicRenderDriver: z.boolean().optional(),
					supportsHardwareEncoding: z.boolean().optional(),
				})
				.optional(),
			allGpus: z
				.object({
					gpus: z.array(
						z.object({
							vendor: z.string(),
							description: z.string(),
							dedicatedVideoMemoryMb: z.number().optional(),
						}),
					),
					isMultiGpuSystem: z.boolean().optional(),
					hasDiscreteGpu: z.boolean().optional(),
				})
				.optional(),
			renderingStatus: z
				.object({
					isUsingSoftwareRendering: z.boolean().optional(),
					isUsingBasicRenderDriver: z.boolean().optional(),
					hardwareEncodingAvailable: z.boolean().optional(),
					warningMessage: z.string().optional(),
				})
				.optional(),
			availableEncoders: z.array(z.string()).optional(),
			graphicsCaptureSupported: z.boolean().optional(),
			screenCaptureSupported: z.boolean().optional(),
			d3D11VideoProcessorAvailable: z.boolean().optional(),
		})
		.optional(),
	cameras: z.array(z.string()).optional(),
	microphones: z.array(z.string()).optional(),
	permissions: z
		.object({
			screenRecording: z.string().optional(),
			camera: z.string().optional(),
			microphone: z.string().optional(),
		})
		.optional(),
});

function formatDiagnosticsForDiscord(
	diagnostics: z.infer<typeof diagnosticsSchema>,
): string {
	const lines: string[] = [];
	const sys = diagnostics.system;

	if (sys?.windowsVersion?.displayName) {
		lines.push(`**OS:** ${sys.windowsVersion.displayName}`);
	} else if (sys?.macosVersion?.displayName) {
		lines.push(`**OS:** ${sys.macosVersion.displayName}`);
	}

	if (sys?.gpuInfo) {
		const gpu = sys.gpuInfo;
		let gpuLine = `**GPU:** ${gpu.description}`;
		if (gpu.vendor) gpuLine += ` (${gpu.vendor})`;
		if (gpu.dedicatedVideoMemoryMb)
			gpuLine += ` - ${gpu.dedicatedVideoMemoryMb}MB VRAM`;
		lines.push(gpuLine);

		const flags: string[] = [];
		if (gpu.isSoftwareAdapter) flags.push("⚠️ Software Adapter");
		if (gpu.isBasicRenderDriver) flags.push("⚠️ Basic Render Driver");
		if (gpu.supportsHardwareEncoding === false) flags.push("❌ No HW Encoding");
		if (gpu.supportsHardwareEncoding === true) flags.push("✅ HW Encoding");
		if (flags.length > 0) lines.push(`**GPU Status:** ${flags.join(", ")}`);
	}

	if (sys?.allGpus?.gpus && sys.allGpus.gpus.length > 1) {
		const gpuList = sys.allGpus.gpus
			.map((g) => `${g.description} (${g.vendor})`)
			.join(", ");
		lines.push(`**All GPUs:** ${gpuList}`);
	}

	if (sys?.renderingStatus?.warningMessage) {
		lines.push(`**⚠️ Warning:** ${sys.renderingStatus.warningMessage}`);
	}

	const captureSupported =
		sys?.graphicsCaptureSupported ?? sys?.screenCaptureSupported;
	if (captureSupported !== undefined) {
		lines.push(
			`**Screen Capture:** ${captureSupported ? "✅ Supported" : "❌ Not Supported"}`,
		);
	}

	if (sys?.d3D11VideoProcessorAvailable !== undefined) {
		lines.push(
			`**D3D11 Video Processor:** ${sys.d3D11VideoProcessorAvailable ? "✅" : "❌"}`,
		);
	}

	if (sys?.availableEncoders && sys.availableEncoders.length > 0) {
		lines.push(`**Encoders:** ${sys.availableEncoders.join(", ")}`);
	}

	if (diagnostics.permissions) {
		const perms = diagnostics.permissions;
		const permList = [
			perms.screenRecording && `Screen: ${perms.screenRecording}`,
			perms.camera && `Camera: ${perms.camera}`,
			perms.microphone && `Mic: ${perms.microphone}`,
		]
			.filter(Boolean)
			.join(", ");
		if (permList) lines.push(`**Permissions:** ${permList}`);
	}

	if (diagnostics.cameras && diagnostics.cameras.length > 0) {
		lines.push(
			`**Cameras (${diagnostics.cameras.length}):** ${diagnostics.cameras.join(", ")}`,
		);
	} else {
		lines.push("**Cameras:** None detected");
	}

	if (diagnostics.microphones && diagnostics.microphones.length > 0) {
		lines.push(
			`**Mics (${diagnostics.microphones.length}):** ${diagnostics.microphones.join(", ")}`,
		);
	} else {
		lines.push("**Mics:** None detected");
	}

	return lines.join("\n");
}

app.post(
	"/logs",
	zValidator(
		"form",
		z.object({
			log: z.string(),
			os: z.string().optional(),
			version: z.string().optional(),
			diagnostics: z.string().optional(),
		}),
	),
	withOptionalAuth,
	async (c) => {
		const {
			log,
			os,
			version,
			diagnostics: diagnosticsJson,
		} = c.req.valid("form");
		const user = c.get("user");

		try {
			const discordWebhookUrl = serverEnv().DISCORD_LOGS_WEBHOOK_URL;
			if (!discordWebhookUrl)
				throw new Error("Discord webhook URL is not configured");

			const formData = new FormData();
			const logBlob = new Blob([log], { type: "text/plain" });
			const fileName = `cap-desktop-${os || "unknown"}-${version || "unknown"}-${Date.now()}.log`;
			formData.append("file", logBlob, fileName);

			let diagnosticsContent = "";
			if (diagnosticsJson) {
				try {
					const parsed = JSON.parse(diagnosticsJson);
					const validated = diagnosticsSchema.safeParse(parsed);
					if (validated.success) {
						diagnosticsContent = formatDiagnosticsForDiscord(validated.data);
					}
				} catch {
					diagnosticsContent = "";
				}
			}

			const content = [
				"📋 **New Log File Uploaded**",
				"",
				user ? `**User:** ${user.email} (${user.id})` : null,
				os ? `**Platform:** ${os}` : null,
				version ? `**App Version:** ${version}` : null,
				diagnosticsContent ? "" : null,
				diagnosticsContent || null,
			]
				.filter((line): line is string => line !== null)
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
		const userEmail = c.get("user").email;

		try {
			await sendEmail({
				email: "hello@cap.so",
				subject: `New Feedback from ${userEmail}`,
				react: Feedback({
					userEmail,
					feedback,
					os,
					version,
				}),
				cc: userEmail,
				replyTo: userEmail,
				fromOverride: "Richie from Cap <richie@send.cap.so>",
			});

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

	return c.json({
		upgraded: isSubscribed,
		stripeSubscriptionStatus: user.stripeSubscriptionStatus,
	});
});

app.get("/organizations", withAuth, async (c) => {
	const user = c.get("user");

	const rows = await db()
		.select({
			id: organizations.id,
			name: organizations.name,
			ownerId: organizations.ownerId,
			tombstoneAt: organizations.tombstoneAt,
			iconUrl: organizations.iconUrl,
			metadata: organizations.metadata,
			role: organizationMembers.role,
		})
		.from(organizations)
		.leftJoin(
			organizationMembers,
			and(
				eq(organizationMembers.organizationId, organizations.id),
				eq(organizationMembers.userId, user.id),
			),
		)
		.where(
			and(
				isNull(organizations.tombstoneAt),
				or(
					eq(organizations.ownerId, user.id),
					eq(organizationMembers.userId, user.id),
				),
			),
		);

	return c.json(await toDesktopOrganizations(rows, user.id));
});

app.patch(
	"/organizations/:organizationId/branding",
	withAuth,
	zValidator("json", OrganizationBrandingPatchBody),
	async (c) => {
		const user = c.get("user");
		const organizationId = Organisation.OrganisationId.make(
			c.req.param("organizationId"),
		);
		const body = normalizeOrganizationBrandingPatchBody(c.req.valid("json"));
		let logoUpdate: ReturnType<typeof decodeOrganizationLogoUpdate>;

		try {
			logoUpdate = decodeOrganizationLogoUpdate(body.logo);
		} catch (error) {
			if (error instanceof OrganizationBrandingValidationError) {
				return c.json({ error: error.message }, { status: 400 });
			}
			throw error;
		}

		const [row] = await db()
			.select({
				id: organizations.id,
				name: organizations.name,
				ownerId: organizations.ownerId,
				tombstoneAt: organizations.tombstoneAt,
				iconUrl: organizations.iconUrl,
				metadata: organizations.metadata,
				role: organizationMembers.role,
			})
			.from(organizations)
			.leftJoin(
				organizationMembers,
				and(
					eq(organizationMembers.organizationId, organizations.id),
					eq(organizationMembers.userId, user.id),
				),
			)
			.where(eq(organizations.id, organizationId))
			.limit(1);

		if (!row || row.tombstoneAt !== null) {
			return c.json({ error: "Organization not found" }, { status: 404 });
		}

		if (!canEditOrganizationBranding(row, user.id)) {
			return c.json(
				{ error: "Only organization owners can edit branding" },
				{ status: 403 },
			);
		}

		await applyOrganizationLogoUpdate(row, logoUpdate);

		await db()
			.update(organizations)
			.set({
				metadata: mergeOrganizationBrandingMetadata(
					row.metadata,
					body.brandColors,
				),
			})
			.where(eq(organizations.id, organizationId));

		const [updatedRow] = await db()
			.select({
				id: organizations.id,
				name: organizations.name,
				ownerId: organizations.ownerId,
				tombstoneAt: organizations.tombstoneAt,
				iconUrl: organizations.iconUrl,
				metadata: organizations.metadata,
				role: organizationMembers.role,
			})
			.from(organizations)
			.leftJoin(
				organizationMembers,
				and(
					eq(organizationMembers.organizationId, organizations.id),
					eq(organizationMembers.userId, user.id),
				),
			)
			.where(eq(organizations.id, organizationId))
			.limit(1);

		if (!updatedRow) {
			return c.json({ error: "Organization not found" }, { status: 404 });
		}

		return c.json(
			toDesktopOrganization(
				updatedRow,
				user.id,
				await resolveOrganizationIconUrl(updatedRow.iconUrl),
			),
		);
	},
);

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
