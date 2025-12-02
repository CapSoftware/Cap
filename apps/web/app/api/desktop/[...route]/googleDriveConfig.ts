import { db } from "@cap/database";
import { decrypt, encrypt } from "@cap/database/crypto";
import { nanoId } from "@cap/database/helpers";
import { googleDriveConfigs } from "@cap/database/schema";
import { GoogleDrive } from "@cap/web-domain";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { withAuth } from "@/app/api/utils";

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

export const app = new Hono().use(withAuth);

app.get("/get", async (c) => {
	const user = c.get("user");

	try {
		const [config] = await db()
			.select()
			.from(googleDriveConfigs)
			.where(eq(googleDriveConfigs.ownerId, user.id));

		if (!config) {
			return c.json({
				config: null,
			});
		}

		return c.json({
			config: {
				id: config.id,
				email: config.email,
				folderId: config.folderId,
				folderName: config.folderName,
				connected: true,
			},
		});
	} catch (error) {
		console.error("Error in Google Drive config get route:", error);
		return c.json(
			{
				error: "Failed to fetch Google Drive configuration",
				details: error instanceof Error ? error.message : String(error),
			},
			{ status: 500 },
		);
	}
});

app.get("/auth-url", async (c) => {
	const clientId = process.env.GOOGLE_CLIENT_ID;
	const redirectUri = `${process.env.NEXT_PUBLIC_WEB_URL || process.env.WEB_URL}/api/desktop/google-drive/config/callback`;

	if (!clientId) {
		return c.json({ error: "Google OAuth not configured" }, { status: 500 });
	}

	const scope = [
		"https://www.googleapis.com/auth/drive.file",
		"https://www.googleapis.com/auth/userinfo.email",
		"https://www.googleapis.com/auth/userinfo.profile",
	].join(" ");

	const authUrl =
		"https://accounts.google.com/o/oauth2/v2/auth?" +
		new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri,
			response_type: "code",
			scope,
			access_type: "offline",
			prompt: "consent",
		}).toString();

	return c.json({ authUrl });
});

app.post(
	"/exchange",
	zValidator(
		"json",
		z.object({
			code: z.string(),
		}),
	),
	async (c) => {
		const user = c.get("user");
		const { code } = c.req.valid("json");

		const clientId = process.env.GOOGLE_CLIENT_ID;
		const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
		const redirectUri = `${process.env.NEXT_PUBLIC_WEB_URL || process.env.WEB_URL}/api/desktop/google-drive/config/callback`;

		if (!clientId || !clientSecret) {
			return c.json({ error: "Google OAuth not configured" }, { status: 500 });
		}

		try {
			const tokenResponse = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: clientId,
					client_secret: clientSecret,
					code,
					grant_type: "authorization_code",
					redirect_uri: redirectUri,
				}),
			});

			if (!tokenResponse.ok) {
				const error = await tokenResponse.text();
				console.error("Token exchange failed:", error);
				return c.json(
					{ error: "Failed to exchange code for tokens" },
					{ status: 500 },
				);
			}

			const tokens = (await tokenResponse.json()) as {
				access_token: string;
				refresh_token: string;
				expires_in: number;
			};

			const userInfoResponse = await fetch(GOOGLE_USERINFO_URL, {
				headers: { Authorization: `Bearer ${tokens.access_token}` },
			});

			let email: string | null = null;
			if (userInfoResponse.ok) {
				const userInfo = (await userInfoResponse.json()) as { email: string };
				email = userInfo.email;
			}

			const encryptedAccessToken = await encrypt(tokens.access_token);
			const encryptedRefreshToken = await encrypt(tokens.refresh_token);
			const expiresAt = Math.floor(Date.now() / 1000) + tokens.expires_in - 60;

			const [existingConfig] = await db()
				.select()
				.from(googleDriveConfigs)
				.where(eq(googleDriveConfigs.ownerId, user.id));

			const configId =
				existingConfig?.id || GoogleDrive.GoogleDriveConfigId.make(nanoId());

			if (existingConfig) {
				await db()
					.update(googleDriveConfigs)
					.set({
						accessToken: encryptedAccessToken,
						refreshToken: encryptedRefreshToken,
						expiresAt,
						email,
					})
					.where(eq(googleDriveConfigs.id, existingConfig.id));
			} else {
				await db().insert(googleDriveConfigs).values({
					id: configId,
					ownerId: user.id,
					accessToken: encryptedAccessToken,
					refreshToken: encryptedRefreshToken,
					expiresAt,
					email,
				});
			}

			return c.json({
				success: true,
				config: {
					id: configId,
					email,
					connected: true,
				},
			});
		} catch (error) {
			console.error("Error exchanging code:", error);
			return c.json(
				{
					error: "Failed to connect Google Drive",
					details: error instanceof Error ? error.message : String(error),
				},
				{ status: 500 },
			);
		}
	},
);

app.post(
	"/set-folder",
	zValidator(
		"json",
		z.object({
			folderId: z.string().nullable(),
			folderName: z.string().nullable(),
		}),
	),
	async (c) => {
		const user = c.get("user");
		const { folderId, folderName } = c.req.valid("json");

		try {
			await db()
				.update(googleDriveConfigs)
				.set({ folderId, folderName })
				.where(eq(googleDriveConfigs.ownerId, user.id));

			return c.json({ success: true });
		} catch (error) {
			console.error("Error setting folder:", error);
			return c.json(
				{
					error: "Failed to set folder",
					details: error instanceof Error ? error.message : String(error),
				},
				{ status: 500 },
			);
		}
	},
);

app.get("/folders", async (c) => {
	const user = c.get("user");

	try {
		const [config] = await db()
			.select()
			.from(googleDriveConfigs)
			.where(eq(googleDriveConfigs.ownerId, user.id));

		if (!config) {
			return c.json({ error: "Google Drive not connected" }, { status: 400 });
		}

		let accessToken = await decrypt(config.accessToken);
		const refreshToken = await decrypt(config.refreshToken);

		const now = Math.floor(Date.now() / 1000);
		if (config.expiresAt <= now) {
			const clientId = process.env.GOOGLE_CLIENT_ID;
			const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

			if (!clientId || !clientSecret) {
				return c.json(
					{ error: "Google OAuth not configured" },
					{ status: 500 },
				);
			}

			const tokenResponse = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: clientId,
					client_secret: clientSecret,
					refresh_token: refreshToken,
					grant_type: "refresh_token",
				}),
			});

			if (!tokenResponse.ok) {
				return c.json({ error: "Failed to refresh token" }, { status: 500 });
			}

			const tokens = (await tokenResponse.json()) as {
				access_token: string;
				expires_in: number;
			};

			accessToken = tokens.access_token;
			const newExpiresAt =
				Math.floor(Date.now() / 1000) + tokens.expires_in - 60;

			await db()
				.update(googleDriveConfigs)
				.set({
					accessToken: await encrypt(accessToken),
					expiresAt: newExpiresAt,
				})
				.where(eq(googleDriveConfigs.id, config.id));
		}

		const response = await fetch(
			`https://www.googleapis.com/drive/v3/files?` +
				new URLSearchParams({
					q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
					fields: "files(id, name)",
					pageSize: "100",
				}),
			{
				headers: { Authorization: `Bearer ${accessToken}` },
			},
		);

		if (!response.ok) {
			const error = await response.text();
			console.error("Failed to list folders:", error);
			return c.json({ error: "Failed to list folders" }, { status: 500 });
		}

		const data = (await response.json()) as {
			files: Array<{ id: string; name: string }>;
		};
		return c.json({ folders: data.files });
	} catch (error) {
		console.error("Error listing folders:", error);
		return c.json(
			{
				error: "Failed to list folders",
				details: error instanceof Error ? error.message : String(error),
			},
			{ status: 500 },
		);
	}
});

app.post(
	"/create-folder",
	zValidator(
		"json",
		z.object({
			name: z.string(),
		}),
	),
	async (c) => {
		const user = c.get("user");
		const { name } = c.req.valid("json");

		try {
			const [config] = await db()
				.select()
				.from(googleDriveConfigs)
				.where(eq(googleDriveConfigs.ownerId, user.id));

			if (!config) {
				return c.json({ error: "Google Drive not connected" }, { status: 400 });
			}

			let accessToken = await decrypt(config.accessToken);
			const refreshToken = await decrypt(config.refreshToken);

			const now = Math.floor(Date.now() / 1000);
			if (config.expiresAt <= now) {
				const clientId = process.env.GOOGLE_CLIENT_ID;
				const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

				if (!clientId || !clientSecret) {
					return c.json(
						{ error: "Google OAuth not configured" },
						{ status: 500 },
					);
				}

				const tokenResponse = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						client_id: clientId,
						client_secret: clientSecret,
						refresh_token: refreshToken,
						grant_type: "refresh_token",
					}),
				});

				if (!tokenResponse.ok) {
					return c.json({ error: "Failed to refresh token" }, { status: 500 });
				}

				const tokens = (await tokenResponse.json()) as {
					access_token: string;
					expires_in: number;
				};

				accessToken = tokens.access_token;
				const newExpiresAt =
					Math.floor(Date.now() / 1000) + tokens.expires_in - 60;

				await db()
					.update(googleDriveConfigs)
					.set({
						accessToken: await encrypt(accessToken),
						expiresAt: newExpiresAt,
					})
					.where(eq(googleDriveConfigs.id, config.id));
			}

			const response = await fetch(
				"https://www.googleapis.com/drive/v3/files",
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${accessToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						name,
						mimeType: "application/vnd.google-apps.folder",
					}),
				},
			);

			if (!response.ok) {
				const error = await response.text();
				console.error("Failed to create folder:", error);
				return c.json({ error: "Failed to create folder" }, { status: 500 });
			}

			const folder = (await response.json()) as { id: string; name: string };
			return c.json({ folder });
		} catch (error) {
			console.error("Error creating folder:", error);
			return c.json(
				{
					error: "Failed to create folder",
					details: error instanceof Error ? error.message : String(error),
				},
				{ status: 500 },
			);
		}
	},
);

app.delete("/delete", async (c) => {
	const user = c.get("user");

	try {
		await db()
			.delete(googleDriveConfigs)
			.where(eq(googleDriveConfigs.ownerId, user.id));

		return c.json({ success: true });
	} catch (error) {
		console.error("Error in Google Drive config delete route:", error);
		return c.json(
			{
				error: "Failed to delete Google Drive configuration",
				details: error instanceof Error ? error.message : String(error),
			},
			{ status: 500 },
		);
	}
});

app.get("/callback", async (c) => {
	const code = c.req.query("code");
	const error = c.req.query("error");

	if (error) {
		return c.html(`
			<!DOCTYPE html>
			<html>
			<head><title>Google Drive Connection</title></head>
			<body>
				<script>
					window.opener?.postMessage({ type: 'google-drive-auth-error', error: '${error}' }, '*');
					window.close();
				</script>
				<p>Error: ${error}. You can close this window.</p>
			</body>
			</html>
		`);
	}

	if (!code) {
		return c.html(`
			<!DOCTYPE html>
			<html>
			<head><title>Google Drive Connection</title></head>
			<body>
				<script>
					window.opener?.postMessage({ type: 'google-drive-auth-error', error: 'No code received' }, '*');
					window.close();
				</script>
				<p>Error: No authorization code received. You can close this window.</p>
			</body>
			</html>
		`);
	}

	return c.html(`
		<!DOCTYPE html>
		<html>
		<head><title>Google Drive Connection</title></head>
		<body>
			<script>
				window.opener?.postMessage({ type: 'google-drive-auth-success', code: '${code}' }, '*');
				window.close();
			</script>
			<p>Authorization successful! You can close this window.</p>
		</body>
		</html>
	`);
});

app.post(
	"/initiate-upload",
	zValidator(
		"json",
		z.object({
			videoId: z.string(),
			fileName: z.string(),
			mimeType: z.string().default("video/mp4"),
		}),
	),
	async (c) => {
		const user = c.get("user");
		const { videoId, fileName, mimeType } = c.req.valid("json");

		try {
			const [config] = await db()
				.select()
				.from(googleDriveConfigs)
				.where(eq(googleDriveConfigs.ownerId, user.id));

			if (!config) {
				return c.json({ error: "Google Drive not connected" }, { status: 400 });
			}

			let accessToken = await decrypt(config.accessToken);
			const refreshToken = await decrypt(config.refreshToken);

			const now = Math.floor(Date.now() / 1000);
			if (config.expiresAt <= now) {
				const clientId = process.env.GOOGLE_CLIENT_ID;
				const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

				if (!clientId || !clientSecret) {
					return c.json(
						{ error: "Google OAuth not configured" },
						{ status: 500 },
					);
				}

				const tokenResponse = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						client_id: clientId,
						client_secret: clientSecret,
						refresh_token: refreshToken,
						grant_type: "refresh_token",
					}),
				});

				if (!tokenResponse.ok) {
					return c.json({ error: "Failed to refresh token" }, { status: 500 });
				}

				const tokens = (await tokenResponse.json()) as {
					access_token: string;
					expires_in: number;
				};

				accessToken = tokens.access_token;
				const newExpiresAt =
					Math.floor(Date.now() / 1000) + tokens.expires_in - 60;

				await db()
					.update(googleDriveConfigs)
					.set({
						accessToken: await encrypt(accessToken),
						expiresAt: newExpiresAt,
					})
					.where(eq(googleDriveConfigs.id, config.id));
			}

			const metadata = {
				name: fileName,
				mimeType,
				parents: config.folderId ? [config.folderId] : undefined,
			};

			const initiateResponse = await fetch(
				"https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${accessToken}`,
						"Content-Type": "application/json; charset=UTF-8",
					},
					body: JSON.stringify(metadata),
				},
			);

			if (!initiateResponse.ok) {
				const error = await initiateResponse.text();
				console.error("Failed to initiate upload:", error);
				return c.json({ error: "Failed to initiate upload" }, { status: 500 });
			}

			const uploadUrl = initiateResponse.headers.get("Location");
			if (!uploadUrl) {
				return c.json({ error: "No upload URL returned" }, { status: 500 });
			}

			return c.json({
				uploadUrl,
				accessToken,
				expiresAt: config.expiresAt,
			});
		} catch (error) {
			console.error("Error initiating upload:", error);
			return c.json(
				{
					error: "Failed to initiate upload",
					details: error instanceof Error ? error.message : String(error),
				},
				{ status: 500 },
			);
		}
	},
);

app.post(
	"/complete-upload",
	zValidator(
		"json",
		z.object({
			videoId: z.string(),
			fileId: z.string(),
		}),
	),
	async (c) => {
		const user = c.get("user");
		const { videoId, fileId } = c.req.valid("json");

		try {
			const [config] = await db()
				.select()
				.from(googleDriveConfigs)
				.where(eq(googleDriveConfigs.ownerId, user.id));

			if (!config) {
				return c.json({ error: "Google Drive not connected" }, { status: 400 });
			}

			let accessToken = await decrypt(config.accessToken);
			const refreshToken = await decrypt(config.refreshToken);

			const now = Math.floor(Date.now() / 1000);
			if (config.expiresAt <= now) {
				const clientId = process.env.GOOGLE_CLIENT_ID;
				const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

				if (!clientId || !clientSecret) {
					return c.json(
						{ error: "Google OAuth not configured" },
						{ status: 500 },
					);
				}

				const tokenResponse = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						client_id: clientId,
						client_secret: clientSecret,
						refresh_token: refreshToken,
						grant_type: "refresh_token",
					}),
				});

				if (!tokenResponse.ok) {
					return c.json({ error: "Failed to refresh token" }, { status: 500 });
				}

				const tokens = (await tokenResponse.json()) as {
					access_token: string;
					expires_in: number;
				};

				accessToken = tokens.access_token;
				const newExpiresAt =
					Math.floor(Date.now() / 1000) + tokens.expires_in - 60;

				await db()
					.update(googleDriveConfigs)
					.set({
						accessToken: await encrypt(accessToken),
						expiresAt: newExpiresAt,
					})
					.where(eq(googleDriveConfigs.id, config.id));
			}

			const permissionResponse = await fetch(
				`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${accessToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						type: "anyone",
						role: "reader",
					}),
				},
			);

			if (!permissionResponse.ok) {
				console.error(
					"Failed to make file public:",
					await permissionResponse.text(),
				);
			}

			const { videos } = await import("@cap/database/schema");
			const { Video } = await import("@cap/web-domain");

			await db()
				.update(videos)
				.set({ googleDriveFileId: fileId })
				.where(eq(videos.id, Video.VideoId.make(videoId)));

			return c.json({ success: true, fileId });
		} catch (error) {
			console.error("Error completing upload:", error);
			return c.json(
				{
					error: "Failed to complete upload",
					details: error instanceof Error ? error.message : String(error),
				},
				{ status: 500 },
			);
		}
	},
);

app.get("/access-token", async (c) => {
	const user = c.get("user");

	try {
		const [config] = await db()
			.select()
			.from(googleDriveConfigs)
			.where(eq(googleDriveConfigs.ownerId, user.id));

		if (!config) {
			return c.json({ error: "Google Drive not connected" }, { status: 400 });
		}

		let accessToken = await decrypt(config.accessToken);
		const refreshToken = await decrypt(config.refreshToken);

		const now = Math.floor(Date.now() / 1000);
		if (config.expiresAt <= now) {
			const clientId = process.env.GOOGLE_CLIENT_ID;
			const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

			if (!clientId || !clientSecret) {
				return c.json(
					{ error: "Google OAuth not configured" },
					{ status: 500 },
				);
			}

			const tokenResponse = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: clientId,
					client_secret: clientSecret,
					refresh_token: refreshToken,
					grant_type: "refresh_token",
				}),
			});

			if (!tokenResponse.ok) {
				return c.json({ error: "Failed to refresh token" }, { status: 500 });
			}

			const tokens = (await tokenResponse.json()) as {
				access_token: string;
				expires_in: number;
			};

			accessToken = tokens.access_token;
			const newExpiresAt =
				Math.floor(Date.now() / 1000) + tokens.expires_in - 60;

			await db()
				.update(googleDriveConfigs)
				.set({
					accessToken: await encrypt(accessToken),
					expiresAt: newExpiresAt,
				})
				.where(eq(googleDriveConfigs.id, config.id));

			return c.json({
				accessToken,
				expiresAt: newExpiresAt,
				folderId: config.folderId,
			});
		}

		return c.json({
			accessToken,
			expiresAt: config.expiresAt,
			folderId: config.folderId,
		});
	} catch (error) {
		console.error("Error getting access token:", error);
		return c.json(
			{
				error: "Failed to get access token",
				details: error instanceof Error ? error.message : String(error),
			},
			{ status: 500 },
		);
	}
});
