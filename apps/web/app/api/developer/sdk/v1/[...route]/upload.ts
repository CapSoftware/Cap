import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { apiErrorBody } from "@/lib/api-errors";
import { CREATE_UPLOAD_PATH } from "@/lib/developer-upload-token";
import {
	abortInfraUpload,
	completeInfraUpload,
	initiateInfraUpload,
	presignInfraUploadParts,
} from "@/lib/infra-video-upload";
import { developerZValidator } from "@/utils/zod-validator";
import { withDeveloperUploadToken } from "../../../../utils";

type Variables = {
	developerAppId: string;
	developerVideoId: string;
	developerUploadCompleted: boolean;
	developerUploadMaxBytes: number | null;
};

export const app = new Hono<{ Variables: Variables }>().use(
	withDeveloperUploadToken,
);

const videoMismatch = apiErrorBody(
	"video_mismatch",
	"This upload token is for a different video",
	"Leave videoId out, or send the videoId returned with this token. Each token uploads one video.",
);

const tokenUsed = apiErrorBody(
	"upload_already_completed",
	"Upload already completed",
	`This upload token has been used. Create a new upload with POST ${CREATE_UPLOAD_PATH}.`,
);

function boundUpload(
	c: Context<{ Variables: Variables }>,
	requestedVideoId: string | undefined,
) {
	const videoId = c.get("developerVideoId");
	if (requestedVideoId !== undefined && requestedVideoId !== videoId) {
		return null;
	}
	return { appId: c.get("developerAppId"), videoId };
}

const partNumber = z.number().int().min(1).max(10000);

app.post(
	"/initiate",
	developerZValidator(
		"json",
		z.object({
			videoId: z.string().optional(),
			contentType: z.string().optional(),
			contentLength: z.number().int().positive().optional(),
		}),
	),
	async (c) => {
		const { videoId, contentType, contentLength } = c.req.valid("json");
		const upload = boundUpload(c, videoId);
		if (!upload) return c.json(videoMismatch, 403);
		const result = await initiateInfraUpload({
			...upload,
			contentType,
			contentLength,
			maxBytes: c.get("developerUploadMaxBytes"),
		});
		return c.json(result.body, result.status);
	},
);

app.post(
	"/presign-part",
	developerZValidator(
		"json",
		z
			.object({
				videoId: z.string().optional(),
				uploadId: z.string(),
				partNumber: partNumber.optional(),
				partNumbers: z.array(partNumber).optional(),
			})
			.refine(
				(body) =>
					(body.partNumber === undefined) !== (body.partNumbers === undefined),
				{ message: "Send either partNumber or partNumbers" },
			),
	),
	async (c) => {
		const { videoId, uploadId, ...requested } = c.req.valid("json");
		const upload = boundUpload(c, videoId);
		if (!upload) return c.json(videoMismatch, 403);
		const result = await presignInfraUploadParts({
			...upload,
			uploadId,
			partNumbers:
				requested.partNumbers ??
				(requested.partNumber === undefined ? [] : [requested.partNumber]),
		});
		if (result.status !== 200) return c.json(result.body, result.status);
		if (requested.partNumbers) return c.json({ parts: result.body.parts });
		return c.json({ presignedUrl: result.body.parts[0]?.presignedUrl });
	},
);

app.post(
	"/complete",
	developerZValidator(
		"json",
		z.object({
			videoId: z.string().optional(),
			uploadId: z.string(),
			parts: z.array(
				z.object({
					partNumber,
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
		const { videoId, ...body } = c.req.valid("json");
		const upload = boundUpload(c, videoId);
		if (!upload) return c.json(videoMismatch, 403);
		const result = await completeInfraUpload({
			...upload,
			...body,
			maxBytes: c.get("developerUploadMaxBytes"),
		});
		if (result.status === 200) return c.json(result.body);
		return c.json(result.body, result.status, result.headers);
	},
);

app.post(
	"/abort",
	developerZValidator(
		"json",
		z.object({
			videoId: z.string().optional(),
			uploadId: z.string(),
		}),
	),
	async (c) => {
		const { videoId, uploadId } = c.req.valid("json");
		const upload = boundUpload(c, videoId);
		if (!upload) return c.json(videoMismatch, 403);
		if (c.get("developerUploadCompleted")) return c.json(tokenUsed, 409);
		const result = await abortInfraUpload({ ...upload, uploadId });
		return c.json(result.body, result.status);
	},
);
