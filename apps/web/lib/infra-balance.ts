import { db } from "@cap/database";
import { developerCreditAccounts } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import type { InfraDbExecutor } from "@/lib/infra-standing";

export async function availableBalance(
	appId: string,
	executor: InfraDbExecutor = db(),
): Promise<number | null> {
	const [account] = await executor
		.select({
			balanceMicroCredits: developerCreditAccounts.balanceMicroCredits,
		})
		.from(developerCreditAccounts)
		.where(eq(developerCreditAccounts.appId, appId))
		.limit(1);
	return account ? account.balanceMicroCredits : null;
}
