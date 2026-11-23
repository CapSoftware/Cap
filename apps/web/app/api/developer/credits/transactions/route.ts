import { db } from "@cap/database";
import { developerApps } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { handle } from "hono/vercel";
import { z } from "zod";
import { canUseInfra } from "@/lib/infra-access";
import { LEDGER_CSV_HEADER, ledgerCsvLine } from "@/lib/infra-ledger";
import { readAppLedger } from "@/lib/infra-ledger-store";
import { utcDateKey } from "@/lib/infra-usage";
import { zValidator } from "@/utils/zod-validator";
import { corsMiddleware, withAuth } from "../../../utils";

const app = new Hono()
	.basePath("/api/developer/credits/transactions")
	.use(corsMiddleware)
	.use(withAuth);

function ledgerCsvStream(appId: string) {
	const encoder = new TextEncoder();
	const batches = readAppLedger(appId);
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(LEDGER_CSV_HEADER));
		},
		async pull(controller) {
			const next = await batches.next();
			if (next.done) {
				controller.close();
				return;
			}
			controller.enqueue(
				encoder.encode(next.value.map(ledgerCsvLine).join("")),
			);
		},
		async cancel() {
			await batches.return(undefined);
		},
	});
}

app.get(
	"/",
	zValidator("query", z.object({ appId: z.string().min(1).max(64) })),
	async (c) => {
		const user = c.get("user");
		const { appId } = c.req.valid("query");

		if (!canUseInfra(user.email)) {
			return c.json({ error: "Cap Infra is not available yet" }, 403);
		}

		const [owned] = await db()
			.select({ id: developerApps.id })
			.from(developerApps)
			.where(
				and(
					eq(developerApps.id, appId),
					eq(developerApps.ownerId, user.id),
					isNull(developerApps.deletedAt),
				),
			)
			.limit(1);

		if (!owned) {
			return c.json({ error: "App not found" }, 404);
		}

		return new Response(ledgerCsvStream(owned.id), {
			headers: {
				"Content-Type": "text/csv; charset=utf-8",
				"Content-Disposition": `attachment; filename="cap-infra-transactions-${utcDateKey(new Date())}.csv"`,
				"Cache-Control": "private, no-store",
			},
		});
	},
);

export const GET = handle(app);
export const OPTIONS = handle(app);
