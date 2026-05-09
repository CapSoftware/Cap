import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import { decrypt, encrypt } from "@cap/database/crypto";
import { nanoId } from "@cap/database/helpers";
import {
	storageIntegrations,
	storageObjects,
	videos,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { userIsPro } from "@cap/utils";
import {
	ensureGoogleDriveFolder,
	exchangeGoogleDriveCode,
	type GoogleDriveIntegrationConfig,
	getGoogleDriveAuthUrl,
	getGoogleDriveUserEmail,
} from "@cap/web-backend";
import { Organisation, Storage, User } from "@cap/web-domain";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCachedGoogleDriveStorageQuota } from "@/lib/google-drive-storage-quota";
import { runPromise } from "@/lib/server";
import { withAuth } from "../../utils";
import {
	getAccessibleOrganization,
	getActiveOrganizationGoogleDriveIntegration,
	getManagedOrganizationStorage,
	getOrganizationGoogleDriveIntegration,
	requireOrganizationOwner,
} from "./organizationStorage";

const GoogleDriveOAuthState = z.object({
	userId: z.string(),
	expiresAt: z.number(),
	scope: z.enum(["user", "organization"]).default("user"),
	organizationId: z.string().optional(),
});

const googleDriveProvider = "googleDrive";

const RefreshStorageQuotaQuery = z.object({
	refreshStorageQuota: z
		.union([z.literal("true"), z.literal("false"), z.boolean()])
		.optional()
		.transform((value) => value === true || value === "true"),
	orgId: z
		.string()
		.optional()
		.transform((value) =>
			value ? Organisation.OrganisationId.make(value) : undefined,
		),
});

const ConnectGoogleDriveStorageBody = z.object({
	orgId: z
		.string()
		.optional()
		.transform((value) =>
			value ? Organisation.OrganisationId.make(value) : undefined,
		),
});

const signStatePayload = (payload: string) =>
	createHmac("sha256", serverEnv().NEXTAUTH_SECRET)
		.update(payload)
		.digest("base64url");

const createGoogleDriveState = (
	userId: string,
	organizationId?: Organisation.OrganisationId,
) => {
	const payload = Buffer.from(
		JSON.stringify({
			userId,
			expiresAt: Date.now() + 10 * 60 * 1000,
			scope: organizationId ? "organization" : "user",
			organizationId,
		}),
	).toString("base64url");
	return `${payload}.${signStatePayload(payload)}`;
};

const verifyGoogleDriveState = (state: string) => {
	const [payload, signature] = state.split(".");
	if (!payload || !signature) throw new Error("Invalid OAuth state");
	const expected = signStatePayload(payload);
	const signatureBuffer = Buffer.from(signature);
	const expectedBuffer = Buffer.from(expected);
	if (
		signatureBuffer.length !== expectedBuffer.length ||
		!timingSafeEqual(signatureBuffer, expectedBuffer)
	) {
		throw new Error("Invalid OAuth state");
	}

	const parsed = GoogleDriveOAuthState.parse(
		JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
	);
	if (parsed.expiresAt < Date.now()) throw new Error("Expired OAuth state");
	return {
		userId: User.UserId.make(parsed.userId),
		organizationId:
			parsed.scope === "organization" && parsed.organizationId
				? Organisation.OrganisationId.make(parsed.organizationId)
				: undefined,
	};
};

const escapeHtml = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

const googleDriveIconSvg = `<svg viewBox="0 0 87.3 78" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/><path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47"/><path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/><path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/><path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/><path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/></svg>`;

const baseHtmlStyles = `body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f5f3;color:#1f1f1f}
main{max-width:440px;padding:40px 32px;text-align:center}
.icon{width:56px;height:56px;margin:0 auto 20px;display:block}
h1{font-size:22px;margin:0 0 8px;font-weight:600;letter-spacing:-0.01em}
p{font-size:14px;line-height:1.55;color:#5f5f5f;margin:0 auto;max-width:340px}
.countdown{font-weight:500;color:#1f1f1f;font-variant-numeric:tabular-nums}
.actions{margin-top:24px;display:flex;justify-content:center}
.button{display:inline-flex;align-items:center;gap:8px;padding:10px 18px;border-radius:9999px;background:#1f1f1f;color:#ffffff;text-decoration:none;font-size:13px;font-weight:500;transition:background-color .15s ease;border:none;cursor:pointer;font-family:inherit}
.button:hover{background:#383838}`;

type CallbackHtmlOptions = {
	title: string;
	body: string;
	redirectUrl?: string;
	redirectLabel?: string;
	redirectSeconds?: number;
};

const htmlResponse = ({
	title,
	body,
	redirectUrl,
	redirectLabel,
	redirectSeconds = 5,
}: CallbackHtmlOptions) => {
	const message = redirectUrl
		? `${escapeHtml(body)} Redirecting in <span class="countdown" id="cap-countdown">${redirectSeconds}</span>s.`
		: escapeHtml(body);
	const action = redirectUrl
		? `<div class="actions"><a class="button" href="${escapeHtml(redirectUrl)}">${escapeHtml(redirectLabel ?? "Back to Cap")}</a></div>`
		: "";
	const script = redirectUrl
		? `<script>(function(){var s=${redirectSeconds};var el=document.getElementById('cap-countdown');var t=setInterval(function(){s-=1;if(s<=0){clearInterval(t);window.location.replace(${JSON.stringify(redirectUrl)});return;}if(el)el.textContent=String(s);},1000);})();</script>`
		: "";
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${baseHtmlStyles}</style>
</head>
<body>
<main>
<div class="icon">${googleDriveIconSvg}</div>
<h1>${escapeHtml(title)}</h1>
<p>${message}</p>
${action}
</main>
${script}
</body>
</html>`;
};

const getGoogleDriveIntegration = (ownerId: User.UserId) =>
	db()
		.select()
		.from(storageIntegrations)
		.where(
			and(
				eq(storageIntegrations.ownerId, ownerId),
				isNull(storageIntegrations.organizationId),
				eq(storageIntegrations.provider, googleDriveProvider),
			),
		)
		.orderBy(
			desc(storageIntegrations.active),
			desc(storageIntegrations.updatedAt),
		)
		.limit(1);

export const app = new Hono();

const protectedApp = new Hono().use(withAuth);

protectedApp.get(
	"/integrations",
	zValidator("query", RefreshStorageQuotaQuery),
	async (c) => {
		const user = c.get("user");
		const { refreshStorageQuota, orgId } = c.req.valid("query");
		if (orgId) {
			const organization = await getAccessibleOrganization(user.id, orgId);
			if (!organization)
				return c.json({ error: "forbidden_org" }, { status: 403 });

			const managedByOrganization = await getManagedOrganizationStorage(
				user.id,
				orgId,
			);
			if (managedByOrganization) {
				const drive =
					managedByOrganization.activeProvider === "googleDrive"
						? await getActiveOrganizationGoogleDriveIntegration(orgId)
						: await getOrganizationGoogleDriveIntegration(orgId);
				const storageQuota =
					drive && drive.status === "active"
						? await getCachedGoogleDriveStorageQuota(drive, {
								forceRefresh: refreshStorageQuota,
							})
						: null;

				return c.json({
					activeProvider: managedByOrganization.activeProvider,
					managedByOrganization,
					googleDrive:
						drive && managedByOrganization.activeProvider === "googleDrive"
							? {
									id: drive.id,
									connected: drive.status === "active",
									active: drive.active,
									status: drive.status,
									displayName: drive.displayName,
									storageQuota,
								}
							: {
									id: null,
									connected: false,
									active: false,
									status: null,
									displayName: null,
									storageQuota: null,
								},
				});
			}
		}

		const [drive] = await getGoogleDriveIntegration(user.id);
		const storageQuota = drive
			? await getCachedGoogleDriveStorageQuota(drive, {
					forceRefresh: refreshStorageQuota,
				})
			: null;

		return c.json({
			activeProvider:
				drive?.active && drive.status === "active" ? "googleDrive" : "s3",
			managedByOrganization: null,
			googleDrive: drive
				? {
						id: drive.id,
						connected: drive.status === "active",
						active: drive.active,
						status: drive.status,
						displayName: drive.displayName,
						storageQuota,
					}
				: {
						id: null,
						connected: false,
						active: false,
						status: null,
						displayName: null,
						storageQuota: null,
					},
		});
	},
);

protectedApp.post(
	"/google-drive/connect",
	zValidator("json", ConnectGoogleDriveStorageBody),
	async (c) => {
		const user = c.get("user");
		const { orgId } = c.req.valid("json");
		if (!userIsPro(user)) {
			return c.json({ error: "upgrade_required" }, { status: 403 });
		}

		if (orgId) {
			const organization = await requireOrganizationOwner(user.id, orgId);
			if (!organization)
				return c.json({ error: "forbidden_org" }, { status: 403 });
		}

		const state = createGoogleDriveState(user.id, orgId);
		return c.json({
			url: getGoogleDriveAuthUrl({ state }),
		});
	},
);

protectedApp.post("/google-drive/test", async (c) => {
	const user = c.get("user");
	const [drive] = await getGoogleDriveIntegration(user.id);
	if (!drive || drive.status !== "active") {
		return c.json({ error: "not_connected" }, { status: 404 });
	}

	const config = JSON.parse(
		await decrypt(drive.encryptedConfig),
	) as GoogleDriveIntegrationConfig;
	const email = await getGoogleDriveUserEmail(config).pipe(runPromise);

	return c.json({ success: true, email: email ?? null });
});

protectedApp.post(
	"/set-active",
	zValidator(
		"json",
		z.object({
			provider: z.enum(["s3", "googleDrive"]),
		}),
	),
	async (c) => {
		const user = c.get("user");
		const { provider } = c.req.valid("json");

		const activated = await db().transaction(async (tx) => {
			const [driveToActivate] =
				provider === "googleDrive"
					? await tx
							.select()
							.from(storageIntegrations)
							.where(
								and(
									eq(storageIntegrations.ownerId, user.id),
									isNull(storageIntegrations.organizationId),
									eq(storageIntegrations.provider, googleDriveProvider),
									eq(storageIntegrations.status, "active"),
								),
							)
							.orderBy(
								desc(storageIntegrations.active),
								desc(storageIntegrations.updatedAt),
							)
							.limit(1)
					: [];

			if (provider === "googleDrive" && !driveToActivate) {
				return false;
			}

			await tx
				.update(storageIntegrations)
				.set({ active: false })
				.where(
					and(
						eq(storageIntegrations.ownerId, user.id),
						isNull(storageIntegrations.organizationId),
					),
				);

			if (provider === "googleDrive" && driveToActivate) {
				await tx
					.update(storageIntegrations)
					.set({ active: true })
					.where(eq(storageIntegrations.id, driveToActivate.id));
			}

			return true;
		});

		if (!activated) {
			return c.json({ error: "not_connected" }, { status: 404 });
		}

		return c.json({ success: true });
	},
);

protectedApp.delete("/google-drive/disconnect", async (c) => {
	const user = c.get("user");
	await db()
		.update(storageIntegrations)
		.set({
			active: false,
			status: "disconnected",
			googleDriveAccessToken: null,
			googleDriveAccessTokenExpiresAt: null,
			googleDriveTokenRefreshLeaseId: null,
			googleDriveTokenRefreshLeaseExpiresAt: null,
			googleDriveStorageQuotaCache: null,
		})
		.where(
			and(
				eq(storageIntegrations.ownerId, user.id),
				isNull(storageIntegrations.organizationId),
				eq(storageIntegrations.provider, googleDriveProvider),
			),
		);

	return c.json({ success: true });
});

app.route("/", protectedApp);

app.get("/google-drive/callback", async (c) => {
	const orgRedirectUrl = "/dashboard/settings/organization/integrations";
	let organizationIdForRedirect: Organisation.OrganisationId | undefined;
	try {
		const error = c.req.query("error");
		if (error) {
			return c.html(
				htmlResponse({
					title: "Google Drive was not connected",
					body: "You can close this window and try again from Cap settings.",
				}),
				400,
			);
		}

		const code = c.req.query("code");
		const state = c.req.query("state");
		if (!code || !state) {
			return c.html(
				htmlResponse({
					title: "Google Drive was not connected",
					body: "The authorization response was missing required data.",
				}),
				400,
			);
		}

		const { userId, organizationId } = verifyGoogleDriveState(state);
		organizationIdForRedirect = organizationId;
		if (organizationId) {
			const organization = await requireOrganizationOwner(
				userId,
				organizationId,
			);
			if (!organization) throw new Error("Organization access denied");
		}

		const tokens = await exchangeGoogleDriveCode(code).pipe(runPromise);
		if (!tokens.refresh_token) throw new Error("Missing refresh token");

		const initialConfig: GoogleDriveIntegrationConfig = {
			refreshToken: tokens.refresh_token,
			folderId: "",
			scope: tokens.scope,
			folderLayout: organizationId ? "userVideo" : "video",
		};
		const defaultFolderId = await ensureGoogleDriveFolder(
			initialConfig,
			"Cap",
		).pipe(runPromise);
		const config: GoogleDriveIntegrationConfig = {
			...initialConfig,
			folderId: defaultFolderId,
			folderName: "Cap",
		};
		const email = await getGoogleDriveUserEmail(config).pipe(runPromise);
		const encryptedConfig = await encrypt(
			JSON.stringify({ ...config, email: email ?? undefined }),
		);
		const displayName = email ? `Google Drive (${email})` : "Google Drive";
		const active = !organizationId;

		await db().transaction(async (tx) => {
			const integrationScope = organizationId
				? and(
						eq(storageIntegrations.organizationId, organizationId),
						eq(storageIntegrations.provider, googleDriveProvider),
					)
				: and(
						eq(storageIntegrations.ownerId, userId),
						isNull(storageIntegrations.organizationId),
						eq(storageIntegrations.provider, googleDriveProvider),
					);
			const existingIntegrations = await tx
				.select()
				.from(storageIntegrations)
				.where(integrationScope)
				.orderBy(desc(storageIntegrations.updatedAt));

			const dependencyChecks = await Promise.all(
				existingIntegrations.map(async (integration) => {
					const [object] = await tx
						.select({ id: storageObjects.id })
						.from(storageObjects)
						.where(eq(storageObjects.integrationId, integration.id))
						.limit(1);
					const [video] = await tx
						.select({ id: videos.id })
						.from(videos)
						.where(eq(videos.storageIntegrationId, integration.id))
						.limit(1);

					return {
						integration,
						hasStoredData: Boolean(object || video),
					};
				}),
			);
			const reusable = dependencyChecks.find(
				({ hasStoredData }) => !hasStoredData,
			)?.integration;

			await tx
				.update(storageIntegrations)
				.set({ active: false, status: "disconnected" })
				.where(integrationScope);

			if (reusable) {
				await tx
					.update(storageIntegrations)
					.set({
						ownerId: userId,
						organizationId: organizationId ?? null,
						displayName,
						status: "active",
						active,
						encryptedConfig,
						googleDriveAccessToken: null,
						googleDriveAccessTokenExpiresAt: null,
						googleDriveTokenRefreshLeaseId: null,
						googleDriveTokenRefreshLeaseExpiresAt: null,
						googleDriveStorageQuotaCache: null,
					})
					.where(eq(storageIntegrations.id, reusable.id));
				return;
			}

			await tx.insert(storageIntegrations).values({
				id: Storage.StorageIntegrationId.make(nanoId()),
				ownerId: userId,
				organizationId: organizationId ?? null,
				provider: googleDriveProvider,
				displayName,
				status: "active",
				active,
				encryptedConfig,
			});
		});

		if (organizationId) {
			revalidatePath(orgRedirectUrl);
			revalidatePath("/dashboard/settings/organization");
		}

		return c.html(
			htmlResponse(
				organizationId
					? {
							title: "Google Drive connected",
							body: 'Your Google account is now linked to Cap. We\'ve created a "Cap" folder in your Drive to store your recordings.',
							redirectUrl: orgRedirectUrl,
							redirectLabel: "Back to settings",
							redirectSeconds: 5,
						}
					: {
							title: "Google Drive connected",
							body: "Return to the Cap app to finish setting up your storage.",
						},
			),
		);
	} catch (error) {
		console.error("Google Drive OAuth callback failed:", error);
		return c.html(
			htmlResponse(
				organizationIdForRedirect
					? {
							title: "Google Drive was not connected",
							body: "Something went wrong while linking your Google account. You can try again from Cap settings.",
							redirectUrl: orgRedirectUrl,
							redirectLabel: "Back to settings",
							redirectSeconds: 8,
						}
					: {
							title: "Google Drive was not connected",
							body: "You can close this window and try again from Cap settings.",
						},
			),
			500,
		);
	}
});
