import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import { developerVideos } from "@cap/database/schema";
import { buildEnv } from "@cap/env";
import { Hono } from "hono";
import { z } from "zod";
import {
	getInfraUploadAdmission,
	uploadAdmissionError,
} from "@/lib/infra-standing";
import { zValidator } from "@/utils/zod-validator";
import { withDeveloperPublicAuth } from "../../../../utils";

export const app = new Hono<{
	Variables: {
		developerAppId: string;
		developerKeyType: "public";
	};
}>().use(withDeveloperPublicAuth);

app.post(
	"/create",
	zValidator(
		"json",
		z.object({
			name: z.string().max(255).optional(),
			userId: z.string().max(255).optional(),
			metadata: z
				.record(z.string(), z.unknown())
				.optional()
				.refine(
					(val) => val === undefined || JSON.stringify(val).length <= 8192,
					{ message: "Metadata must be under 8KB" },
				),
		}),
	),
	async (c) => {
		const appId = c.get("developerAppId");
		const body = c.req.valid("json");

		const admission = await getInfraUploadAdmission(appId);
		if (!admission.allowed) {
			return c.json(uploadAdmissionError(admission), 402);
		}

		const videoId = nanoId();
		const s3Key = `developer/${appId}/${videoId}/video`;

		await db()
			.insert(developerVideos)
			.values({
				id: videoId,
				appId,
				externalUserId: body.userId,
				name: body.name ?? "Untitled",
				s3Key,
				metadata: body.metadata,
			});

		const webUrl = buildEnv.NEXT_PUBLIC_WEB_URL;

		return c.json({
			videoId,
			s3Key,
			shareUrl: `${webUrl}/dev/${videoId}`,
			embedUrl: `${webUrl}/embed/${videoId}?sdk=1`,
		});
	},
);
