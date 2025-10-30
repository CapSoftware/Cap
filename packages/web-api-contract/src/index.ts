import { z } from "zod";
import desktop from "./desktop";
import { c } from "./util";

export const NotificationAuthor = z.object({
	id: z.string(),
	name: z.string(),
	avatar: z.string().nullable(),
});

export const NotificationBase = z.object({
	id: z.string(),
	readAt: z.coerce.date().nullable(),
	createdAt: z.coerce.date(),
});
export type NotificationBase = z.infer<typeof NotificationBase>;

const CommentData = z.object({
	id: z.string(),
	content: z.string(),
});

export const Notification = z
	.union([
		z.object({
			type: z.literal("view"),
			videoId: z.string(),
			author: NotificationAuthor,
		}),
		z.object({
			type: z.literal("comment"),
			videoId: z.string(),
			author: NotificationAuthor,
			comment: CommentData,
		}),
		z.object({
			type: z.literal("reaction"),
			videoId: z.string(),
			author: NotificationAuthor,
			comment: CommentData,
		}),
		z.object({
			type: z.literal("reply"),
			videoId: z.string(),
			author: NotificationAuthor,
			comment: CommentData,
		}),
		// z.object({
		//   type: z.literal("mention"),
		//   videoId: z.string(),
		//   author: NotificationAuthor,
		//   comment: z.object({
		//     id: z.string(),
		//     content: z.string(),
		//   }),
		// }),
	])
	.and(NotificationBase);
export type Notification = z.infer<typeof Notification>;

export const contract = c.router({
	desktop,
	video: c.router({
		getTranscribeStatus: {
			method: "GET",
			path: "/video/transcribe/status",
			query: z.object({ videoId: z.string() }),
			responses: {
				200: z.object({
					transcriptionStatus: z
						.custom<"PROCESSING" | "COMPLETE" | "ERROR">()
						.nullable(),
				}),
			},
		},
		delete: {
			method: "DELETE",
			path: "/video/delete",
			query: z.object({ videoId: z.string() }),
			responses: { 200: z.unknown() },
		},
		getAnalytics: {
			method: "GET",
			path: "/video/analytics",
			query: z.object({ videoId: z.string() }),
			responses: {
				200: z.object({ count: z.number() }),
			},
		},
	}),
	notifications: c.router({
		get: {
			method: "GET",
			path: "/notifications",
			responses: {
				200: z.object({
					notifications: z.array(Notification),
					count: z.record(z.string(), z.number()),
				}),
			},
		},
	}),
});

export const orgCustomDomainContract = c.router({
	getOrgCustomDomain: {
		method: "GET",
		path: "/org-custom-domain",
		headers: z.object({ authorization: z.string() }),
		responses: {
			200: z.object({
				custom_domain: z.string().nullable(),
				domain_verified: z.boolean().nullable(),
			}),
			500: z.object({
				message: z.string(),
			}),
		},
	},
});

export const licenseContract = c.router({
	activateCommercialLicense: {
		method: "POST",
		path: "/commercial/activate",
		headers: z.object({ licensekey: z.string(), instanceid: z.string() }),
		body: z.object({ reset: z.boolean().optional() }),
		responses: {
			200: z.object({
				message: z.string(),
				expiryDate: z.number().optional(),
				refresh: z.number(),
			}),
			403: z.object({ message: z.string() }),
		},
	},
	createCommercialCheckoutUrl: {
		method: "POST",
		path: "/commercial/checkout",
		body: z.object({
			type: z.enum(["yearly", "lifetime"]),
			quantity: z.number().min(1).max(100).optional(),
		}),
		responses: {
			200: z.object({ url: z.string() }),
			500: z.object({ message: z.string() }),
		},
	},
});
