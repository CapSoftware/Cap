import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import { developerCreditAccounts, developerVideos } from "@cap/database/schema";
import { buildEnv } from "@cap/env";
import { zValidator } from "@hono/zod-validator";
import { and, eq, sql } from "drizzle-orm";
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
			name: z.string().max(255).optional(),
			userId: z.string().max(255).optional(),
			metadata: z
				.record(z.unknown())
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

		const [result] = await db()
			.update(developerCreditAccounts)
			.set({
				balanceMicroCredits: sql`${developerCreditAccounts.balanceMicroCredits} - ${MIN_BALANCE_MICRO_CREDITS}`,
			})
			.where(
				and(
					eq(developerCreditAccounts.appId, appId),
					sql`${developerCreditAccounts.balanceMicroCredits} >= ${MIN_BALANCE_MICRO_CREDITS}`,
				),
			);

		const affectedRows =
			(result as unknown as { affectedRows?: number })?.affectedRows ?? 0;
		if (affectedRows === 0) {
			return c.json({ error: "Insufficient credits" }, 402);
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
