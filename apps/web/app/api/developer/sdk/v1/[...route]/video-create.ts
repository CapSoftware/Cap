import { DEVELOPER_VIDEO_RESOLUTION_TIERS } from "@cap/database/types";
import { Hono } from "hono";
import { z } from "zod";
import { createInfraVideo } from "@/lib/infra-video-upload";
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
			maxResolutionTier: z.enum(DEVELOPER_VIDEO_RESOLUTION_TIERS).optional(),
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
		const result = await createInfraVideo({
			appId: c.get("developerAppId"),
			...c.req.valid("json"),
		});
		return c.json(result.body, result.status);
	},
);
