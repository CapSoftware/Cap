import type { AppRoute } from "@ts-rest/core";
import { z } from "zod";
import { c } from "./util";

const CHANGELOG = z.object({
	metadata: z.object({
		title: z.string(),
		app: z.string(),
		publishedAt: z.string(),
		version: z.string(),
		image: z.string().optional(),
	}),
	content: z.string(),
	slug: z.number(),
});

const publicContract = c.router({
	getChangelogPosts: {
		method: "GET",
		path: "/changelog",
		query: z.object({
			origin: z.string(),
		}),
		responses: {
			200: z.array(
				z.object({ content: z.string() }).and(CHANGELOG.shape.metadata),
			),
		},
	},
	getChangelogStatus: {
		method: "GET",
		path: "/changelog/status",
		query: z.object({
			version: z.string(),
		}),
		responses: {
			200: z.object({ hasUpdate: z.boolean() }),
		},
	},
});

const a = publicContract.getChangelogPosts;
type A = typeof a;

type B = A extends AppRoute ? number : string;

const protectedContract = c.router(
	{
		submitFeedback: {
			method: "POST",
			path: "/desktop/feedback",
			contentType: "application/x-www-form-urlencoded",
			body: z.object({
				feedback: z.string(),
				os: z.union([z.literal("macos"), z.literal("windows")]),
				version: z.string(),
			}),
			responses: {
				200: z.object({ success: z.boolean() }),
			},
		},
		getUserPlan: {
			method: "GET",
			path: "/desktop/plan",
			responses: {
				200: z.object({
					upgraded: z.boolean(),
					stripeSubscriptionStatus: z.string().nullable(),
				}),
			},
		},
		getS3Config: {
			method: "GET",
			path: "/desktop/s3/config/get",
			responses: {
				200: z.object({
					config: z.custom<{
						provider: string;
						accessKeyId: string;
						secretAccessKey: string;
						endpoint: string;
						bucketName: string;
						region: string;
					}>(),
				}),
			},
		},
		setS3Config: {
			method: "POST",
			path: "/desktop/s3/config",
			responses: {
				200: z.object({ success: z.literal(true) }),
			},
			body: z.object({
				provider: z.string(),
				accessKeyId: z.string(),
				secretAccessKey: z.string(),
				endpoint: z.string(),
				bucketName: z.string(),
				region: z.string(),
			}),
		},
		deleteS3Config: {
			method: "DELETE",
			path: "/desktop/s3/config/delete",
			responses: { 200: z.object({ success: z.literal(true) }) },
		},
		testS3Config: {
			method: "POST",
			path: "/desktop/s3/config/test",
			body: z.object({
				provider: z.string(),
				accessKeyId: z.string(),
				secretAccessKey: z.string(),
				endpoint: z.string(),
				bucketName: z.string(),
				region: z.string(),
			}),
			responses: { 200: z.object({ success: z.literal(true) }) },
		},
		getGoogleDriveConfig: {
			method: "GET",
			path: "/desktop/google-drive/config/get",
			responses: {
				200: z.object({
					config: z
						.object({
							id: z.string(),
							email: z.string().nullable(),
							folderId: z.string().nullable(),
							folderName: z.string().nullable(),
							connected: z.boolean(),
						})
						.nullable(),
				}),
			},
		},
		getGoogleDriveAuthUrl: {
			method: "GET",
			path: "/desktop/google-drive/config/auth-url",
			responses: {
				200: z.object({ authUrl: z.string() }),
			},
		},
		exchangeGoogleDriveCode: {
			method: "POST",
			path: "/desktop/google-drive/config/exchange",
			body: z.object({ code: z.string() }),
			responses: {
				200: z.object({
					success: z.literal(true),
					config: z.object({
						id: z.string(),
						email: z.string().nullable(),
						connected: z.boolean(),
					}),
				}),
			},
		},
		setGoogleDriveFolder: {
			method: "POST",
			path: "/desktop/google-drive/config/set-folder",
			body: z.object({
				folderId: z.string().nullable(),
				folderName: z.string().nullable(),
			}),
			responses: { 200: z.object({ success: z.literal(true) }) },
		},
		getGoogleDriveFolders: {
			method: "GET",
			path: "/desktop/google-drive/config/folders",
			responses: {
				200: z.object({
					folders: z.array(z.object({ id: z.string(), name: z.string() })),
				}),
			},
		},
		createGoogleDriveFolder: {
			method: "POST",
			path: "/desktop/google-drive/config/create-folder",
			body: z.object({ name: z.string() }),
			responses: {
				200: z.object({
					folder: z.object({ id: z.string(), name: z.string() }),
				}),
			},
		},
		deleteGoogleDriveConfig: {
			method: "DELETE",
			path: "/desktop/google-drive/config/delete",
			responses: { 200: z.object({ success: z.literal(true) }) },
		},
		initiateGoogleDriveUpload: {
			method: "POST",
			path: "/desktop/google-drive/config/initiate-upload",
			body: z.object({
				videoId: z.string(),
				fileName: z.string(),
				mimeType: z.string().optional(),
			}),
			responses: {
				200: z.object({
					uploadUrl: z.string(),
					accessToken: z.string(),
					expiresAt: z.number(),
				}),
			},
		},
		completeGoogleDriveUpload: {
			method: "POST",
			path: "/desktop/google-drive/config/complete-upload",
			body: z.object({
				videoId: z.string(),
				fileId: z.string(),
			}),
			responses: {
				200: z.object({
					success: z.literal(true),
					fileId: z.string(),
				}),
			},
		},
		getGoogleDriveAccessToken: {
			method: "GET",
			path: "/desktop/google-drive/config/access-token",
			responses: {
				200: z.object({
					accessToken: z.string(),
					expiresAt: z.number(),
					folderId: z.string().nullable(),
				}),
			},
		},
		getProSubscribeURL: {
			method: "POST",
			path: "/desktop/subscribe",
			body: z.object({ priceId: z.string() }),
			responses: {
				200: z.object({ url: z.string() }),
				400: z.object({
					error: z.literal(true),
					subscription: z.literal(true).optional(),
				}),
				401: z.object({
					error: z.literal(true),
					auth: z.literal(false),
				}),
			},
		},
		deleteVideo: {
			method: "DELETE",
			path: "/desktop/video/delete",
			query: z.object({ videoId: z.string() }),
			responses: { 200: z.unknown() },
		},
	},
	{
		baseHeaders: z.object({ authorization: z.string() }),
		commonResponses: { 401: z.object({ error: z.string().or(z.boolean()) }) },
	},
);

export default {
	...publicContract,
	...protectedContract,
};
