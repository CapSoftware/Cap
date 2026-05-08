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
import { Storage, User } from "@cap/web-domain";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getCachedGoogleDriveStorageQuota } from "@/lib/google-drive-storage-quota";
import { runPromise } from "@/lib/server";
import { withAuth } from "../../utils";

const GoogleDriveOAuthState = z.object({
	userId: z.string(),
	expiresAt: z.number(),
});

const googleDriveProvider = "googleDrive";

const RefreshStorageQuotaQuery = z.object({
	refreshStorageQuota: z
		.union([z.literal("true"), z.literal("false"), z.boolean()])
		.optional()
		.transform((value) => value === true || value === "true"),
});

const signStatePayload = (payload: string) =>
	createHmac("sha256", serverEnv().NEXTAUTH_SECRET)
		.update(payload)
		.digest("base64url");

const createGoogleDriveState = (userId: string) => {
	const payload = Buffer.from(
		JSON.stringify({
			userId,
			expiresAt: Date.now() + 10 * 60 * 1000,
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
	return User.UserId.make(parsed.userId);
};

const escapeHtml = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

const htmlResponse = (title: string, body: string) => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f5f3;color:#1f1f1f}
main{max-width:480px;padding:32px;text-align:center}
h1{font-size:24px;margin:0 0 12px}
p{font-size:15px;line-height:1.5;color:#555;margin:0}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(body)}</p>
</main>
</body>
</html>`;

const getGoogleDriveIntegration = (ownerId: User.UserId) =>
	db()
		.select()
		.from(storageIntegrations)
		.where(
			and(
				eq(storageIntegrations.ownerId, ownerId),
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
		const { refreshStorageQuota } = c.req.valid("query");
		const [drive] = await getGoogleDriveIntegration(user.id);
		const storageQuota = drive
			? await getCachedGoogleDriveStorageQuota(drive, {
					forceRefresh: refreshStorageQuota,
				})
			: null;

		return c.json({
			activeProvider:
				drive?.active && drive.status === "active" ? "googleDrive" : "s3",
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

protectedApp.post("/google-drive/connect", async (c) => {
	const user = c.get("user");
	if (!userIsPro(user)) {
		return c.json({ error: "upgrade_required" }, { status: 403 });
	}

	const state = createGoogleDriveState(user.id);
	return c.json({
		url: getGoogleDriveAuthUrl({ state }),
	});
});

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
				.where(eq(storageIntegrations.ownerId, user.id));

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
				eq(storageIntegrations.provider, googleDriveProvider),
			),
		);

	return c.json({ success: true });
});

app.route("/", protectedApp);

app.get("/google-drive/callback", async (c) => {
	try {
		const error = c.req.query("error");
		if (error) {
			return c.html(
				htmlResponse(
					"Google Drive was not connected",
					"You can close this window and try again from Cap settings.",
				),
				400,
			);
		}

		const code = c.req.query("code");
		const state = c.req.query("state");
		if (!code || !state) {
			return c.html(
				htmlResponse(
					"Google Drive was not connected",
					"The authorization response was missing required data.",
				),
				400,
			);
		}

		const userId = verifyGoogleDriveState(state);
		const tokens = await exchangeGoogleDriveCode(code).pipe(runPromise);
		if (!tokens.refresh_token) throw new Error("Missing refresh token");

		const initialConfig: GoogleDriveIntegrationConfig = {
			refreshToken: tokens.refresh_token,
			folderId: "",
			scope: tokens.scope,
		};
		const folderId = await ensureGoogleDriveFolder(initialConfig, "Cap").pipe(
			runPromise,
		);
		const config: GoogleDriveIntegrationConfig = {
			...initialConfig,
			folderId,
		};
		const email = await getGoogleDriveUserEmail(config).pipe(runPromise);
		const encryptedConfig = await encrypt(
			JSON.stringify({ ...config, email: email ?? undefined }),
		);
		const displayName = email ? `Google Drive (${email})` : "Google Drive";

		await db().transaction(async (tx) => {
			const existingIntegrations = await tx
				.select()
				.from(storageIntegrations)
				.where(
					and(
						eq(storageIntegrations.ownerId, userId),
						eq(storageIntegrations.provider, googleDriveProvider),
					),
				)
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
				.where(
					and(
						eq(storageIntegrations.ownerId, userId),
						eq(storageIntegrations.provider, googleDriveProvider),
					),
				);

			if (reusable) {
				await tx
					.update(storageIntegrations)
					.set({
						displayName,
						status: "active",
						active: true,
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
				provider: googleDriveProvider,
				displayName,
				status: "active",
				active: true,
				encryptedConfig,
			});
		});

		return c.html(
			htmlResponse(
				"Google Drive connected",
				"Return to Cap settings to manage your storage provider.",
			),
		);
	} catch (error) {
		console.error("Google Drive OAuth callback failed:", error);
		return c.html(
			htmlResponse(
				"Google Drive was not connected",
				"You can close this window and try again from Cap settings.",
			),
			500,
		);
	}
});
