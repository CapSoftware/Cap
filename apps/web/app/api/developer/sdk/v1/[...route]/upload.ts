import { Hono } from "hono";
import { z } from "zod";
import {
	abortInfraUpload,
	completeInfraUpload,
	initiateInfraUpload,
	presignInfraUploadParts,
} from "@/lib/infra-video-upload";
import { developerZValidator } from "@/utils/zod-validator";
import { withDeveloperPublicAuth } from "../../../../utils";

export const app = new Hono<{
	Variables: {
		developerAppId: string;
		developerKeyType: "public";
	};
}>().use(withDeveloperPublicAuth);

app.post(
	"/initiate",
	developerZValidator(
		"json",
		z.object({
			videoId: z.string(),
			contentType: z.string().optional(),
		}),
	),
	async (c) => {
		const result = await initiateInfraUpload({
			appId: c.get("developerAppId"),
			...c.req.valid("json"),
		});
		return c.json(result.body, result.status);
	},
);

app.post(
	"/presign-part",
	developerZValidator(
		"json",
		z.object({
			videoId: z.string(),
			uploadId: z.string(),
			partNumber: z.number().int().min(1).max(10000),
		}),
	),
	async (c) => {
		const { videoId, uploadId, partNumber } = c.req.valid("json");
		const result = await presignInfraUploadParts({
			appId: c.get("developerAppId"),
			videoId,
			uploadId,
			partNumbers: [partNumber],
		});
		if (result.status !== 200) return c.json(result.body, result.status);
		return c.json({ presignedUrl: result.body.parts[0]?.presignedUrl });
	},
);

app.post(
	"/complete",
	developerZValidator(
		"json",
		z.object({
			videoId: z.string(),
			uploadId: z.string(),
			parts: z.array(
				z.object({
					partNumber: z.number().int().min(1).max(10000),
					etag: z.string(),
					size: z.number().nonnegative(),
				}),
			),
			durationInSecs: z.number().positive(),
			width: z.number().optional(),
			height: z.number().optional(),
			fps: z.number().optional(),
		}),
	),
	async (c) => {
		const result = await completeInfraUpload({
			appId: c.get("developerAppId"),
			...c.req.valid("json"),
		});
		return c.json(result.body, result.status);
	},
);

app.post(
	"/abort",
	developerZValidator(
		"json",
		z.object({
			videoId: z.string(),
			uploadId: z.string(),
		}),
	),
	async (c) => {
		const result = await abortInfraUpload({
			appId: c.get("developerAppId"),
			...c.req.valid("json"),
		});
		return c.json(result.body, result.status);
	},
);
