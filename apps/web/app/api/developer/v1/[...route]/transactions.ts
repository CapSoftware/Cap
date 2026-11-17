import { Hono } from "hono";
import { apiErrorBody } from "@/lib/api-errors";
import { parseDeveloperListQuery } from "@/lib/developer-pagination";
import { serializeLedgerRow } from "@/lib/infra-ledger";
import { listAppLedger } from "@/lib/infra-ledger-store";
import { withDeveloperSecretAuth } from "../../../utils";

export const app = new Hono<{
	Variables: {
		developerAppId: string;
		developerKeyType: "secret";
	};
}>().use(withDeveloperSecretAuth);

app.get("/", async (c) => {
	const parsed = parseDeveloperListQuery(c.req.query(), []);
	if (!parsed.ok) {
		return c.json(apiErrorBody(parsed.code, parsed.message, parsed.hint), 400);
	}
	const { limit, offset } = parsed;

	const { rows, hasMore } = await listAppLedger(c.get("developerAppId"), {
		limit,
		offset,
	});

	return c.json({
		data: rows.map(serializeLedgerRow),
		pagination: { limit, offset, hasMore },
	});
});
