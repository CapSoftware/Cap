import { z } from "zod";
import { c } from "./util";

export const OrganizationHexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export const OrganizationBrandColors = z.object({
	primary: OrganizationHexColor.nullable(),
	secondary: OrganizationHexColor.nullable(),
	accent: OrganizationHexColor.nullable(),
	background: OrganizationHexColor.nullable(),
});
export type OrganizationBrandColors = z.infer<typeof OrganizationBrandColors>;

export const DesktopOrganization = z.object({
	id: z.string(),
	name: z.string(),
	ownerId: z.string(),
	role: z.enum(["owner", "member"]),
	canEditBrand: z.boolean(),
	iconUrl: z.string().nullable(),
	brandColors: OrganizationBrandColors,
});
export type DesktopOrganization = z.infer<typeof DesktopOrganization>;

export const OrganizationLogoUpdate = z.discriminatedUnion("action", [
	z.object({ action: z.literal("keep") }),
	z.object({ action: z.literal("remove") }),
	z.object({
		action: z.literal("upload"),
		contentType: z.enum([
			"image/png",
			"image/jpeg",
			"image/webp",
			"image/gif",
			"image/avif",
		]),
		data: z.string().min(1),
	}),
]);
export type OrganizationLogoUpdate = z.infer<typeof OrganizationLogoUpdate>;

export const OrganizationBrandingPatchBody = z.object({
	brandColors: OrganizationBrandColors,
	logo: OrganizationLogoUpdate.optional(),
});
export type OrganizationBrandingPatchBody = z.infer<
	typeof OrganizationBrandingPatchBody
>;

export const DesktopStorageIntegrations = z.object({
	activeProvider: z.enum(["s3", "googleDrive"]),
	googleDrive: z.object({
		id: z.string().nullable(),
		connected: z.boolean(),
		active: z.boolean(),
		status: z.enum(["active", "disconnected", "error"]).nullable(),
		displayName: z.string().nullable(),
		storageQuota: z
			.object({
				limit: z.string().nullable(),
				usage: z.string().nullable(),
				usageInDrive: z.string().nullable(),
				usageInDriveTrash: z.string().nullable(),
				remaining: z.string().nullable(),
				fetchedAt: z.string(),
				stale: z.boolean(),
			})
			.nullable(),
	}),
});
export type DesktopStorageIntegrations = z.infer<
	typeof DesktopStorageIntegrations
>;

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
		getStorageIntegrations: {
			method: "GET",
			path: "/desktop/storage/integrations",
			query: z
				.object({
					refreshStorageQuota: z.boolean().optional(),
				})
				.optional(),
			responses: {
				200: DesktopStorageIntegrations,
			},
		},
		connectGoogleDriveStorage: {
			method: "POST",
			path: "/desktop/storage/google-drive/connect",
			body: z.object({}).optional(),
			responses: {
				200: z.object({ url: z.string() }),
				403: z.object({ error: z.literal("upgrade_required") }),
			},
		},
		testGoogleDriveStorage: {
			method: "POST",
			path: "/desktop/storage/google-drive/test",
			body: z.object({}).optional(),
			responses: {
				200: z.object({
					success: z.literal(true),
					email: z.string().nullable(),
				}),
				404: z.object({ error: z.literal("not_connected") }),
			},
		},
		setActiveStorageProvider: {
			method: "POST",
			path: "/desktop/storage/set-active",
			body: z.object({
				provider: z.enum(["s3", "googleDrive"]),
			}),
			responses: {
				200: z.object({ success: z.literal(true) }),
			},
		},
		disconnectGoogleDriveStorage: {
			method: "DELETE",
			path: "/desktop/storage/google-drive/disconnect",
			responses: {
				200: z.object({ success: z.literal(true) }),
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
		getOrganizations: {
			method: "GET",
			path: "/desktop/organizations",
			responses: { 200: z.array(DesktopOrganization) },
		},
		updateOrganizationBranding: {
			method: "PATCH",
			path: "/desktop/organizations/:organizationId/branding",
			body: OrganizationBrandingPatchBody,
			responses: {
				200: DesktopOrganization,
				400: z.object({ error: z.string() }),
				403: z.object({ error: z.string() }),
				404: z.object({ error: z.string() }),
			},
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
