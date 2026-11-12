import { DEVELOPER_VIDEO_RESOLUTION_TIERS } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { Hono } from "hono";
import { z } from "zod";
import {
	createDeveloperUploadToken,
	UPLOAD_TOKEN_DEFAULT_SECONDS,
	UPLOAD_TOKEN_MAX_SECONDS,
	UPLOAD_TOKEN_MIN_SECONDS,
} from "@/lib/developer-upload-token";
import { normalizeAllowedOrigin } from "@/lib/infra-domain";
import { createInfraVideo } from "@/lib/infra-video-upload";
import { developerZValidator } from "@/utils/zod-validator";
import { withDeveloperSecretAuth } from "../../../utils";

export const app = new Hono<{
	Variables: {
		developerAppId: string;
		developerKeyType: "secret";
	};
}>().use(withDeveloperSecretAuth);

const isExactOrigin = (value: string) => {
	const allowed = normalizeAllowedOrigin(value);
	return allowed.ok && allowed.origin === value;
};

app.post(
	"/",
	developerZValidator(
		"json",
		z.object({
			name: z.string().max(255).optional(),
			userId: z.string().max(255).optional(),
			maxResolutionTier: z.enum(DEVELOPER_VIDEO_RESOLUTION_TIERS).optional(),
			metadata: z
				.record(z.string(), z.unknown())
				.optional()
				.refine(
					(val) => val === undefined || JSON.stringify(val).length <= 8192,
					{ message: "Metadata must be under 8KB" },
				),
			corsOrigin: z
				.string()
				.optional()
				.refine((val) => val === undefined || isExactOrigin(val), {
					message:
						"corsOrigin must be an exact origin such as https://app.example.com, with no path or trailing slash",
				}),
			timeoutSeconds: z
				.number()
				.int()
				.min(UPLOAD_TOKEN_MIN_SECONDS)
				.max(UPLOAD_TOKEN_MAX_SECONDS)
				.optional(),
		}),
	),
	async (c) => {
		const appId = c.get("developerAppId");
		const { corsOrigin, timeoutSeconds, ...video } = c.req.valid("json");

		const created = await createInfraVideo({ appId, ...video });
		if (created.status !== 200) return c.json(created.body, created.status);
		const { videoId, playbackId, shareUrl, embedUrl } = created.body;

		const expiresAt =
			Date.now() + (timeoutSeconds ?? UPLOAD_TOKEN_DEFAULT_SECONDS) * 1000;
		const token = createDeveloperUploadToken({
			appId,
			videoId,
			expiresAt,
			corsOrigin: corsOrigin ?? null,
		});

		return c.json({
			data: {
				id: videoId,
				videoId,
				token,
				expiresAt: new Date(expiresAt).toISOString(),
				corsOrigin: corsOrigin ?? null,
				status: "uploading" as const,
				uploadUrl: `${serverEnv().WEB_URL.replace(/\/+$/, "")}/api/developer/sdk/v1/upload/multipart`,
				playbackId,
				shareUrl,
				embedUrl,
			},
		});
	},
);
