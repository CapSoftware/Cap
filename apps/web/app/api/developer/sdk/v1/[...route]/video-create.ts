import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import { developerCreditAccounts, developerVideos } from "@cap/database/schema";
import { buildEnv } from "@cap/env";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { withDeveloperPublicAuth } from "../../../../utils";

const MIN_BALANCE_MICRO_CREDITS = 5_000;

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
			name: z.string().optional(),
			userId: z.string().optional(),
			metadata: z.record(z.unknown()).optional(),
		}),
	),
	async (c) => {
		const appId = c.get("developerAppId");
		const body = c.req.valid("json");

		const [account] = await db()
			.select()
			.from(developerCreditAccounts)
			.where(eq(developerCreditAccounts.appId, appId))
			.limit(1);

		if (!account || account.balanceMicroCredits < MIN_BALANCE_MICRO_CREDITS) {
			return c.json({ error: "Insufficient credits" }, 402);
		}

		const videoId = nanoId();
		const s3Key = `developer/${appId}/${videoId}/result.mp4`;

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
