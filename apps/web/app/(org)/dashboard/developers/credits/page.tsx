import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { developerCreditTransactions } from "@cap/database/schema";
import { desc, inArray } from "drizzle-orm";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDeveloperApps } from "../developer-data";
import { CreditsClient } from "./CreditsClient";

export const metadata: Metadata = {
	title: "Developer Credits — Cap",
};

export default async function CreditsPage() {
	const user = await getCurrentUser();
	if (!user) redirect("/auth/signin");

	const apps = await getDeveloperApps(user);

	const accountIds = apps
		.map((a) => a.creditAccount?.id)
		.filter((id): id is string => Boolean(id));

	const transactions =
		accountIds.length > 0
			? await db()
					.select()
					.from(developerCreditTransactions)
					.where(inArray(developerCreditTransactions.accountId, accountIds))
					.orderBy(desc(developerCreditTransactions.createdAt))
					.limit(50)
			: [];

	return <CreditsClient transactions={transactions} />;
}
