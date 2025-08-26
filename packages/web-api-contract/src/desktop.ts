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
			responses: {
				200: z.object({ success: z.boolean() }),
			},
		},
		submitRecording: {
			method: "POST",
			path: "/desktop/recording",
			body: z.object({
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
			responses: {
				200: z.object({ success: z.boolean(), message: z.string() }),
			},
		},
		submitLogs: {
			method: "POST",
			path: "/desktop/logs",
			body: z.object({
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
			responses: {
				200: z.object({ success: z.boolean(), message: z.string() }),
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
