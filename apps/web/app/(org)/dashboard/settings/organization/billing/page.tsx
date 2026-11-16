import { buildEnv } from "@cap/env";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AddOnsSummary } from "../components/AddOnsSummary";
import { AddOnsStatus } from "./AddOnsStatus";
import { BillingContent } from "./BillingContent";

export default async function BillingPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	if (!buildEnv.NEXT_PUBLIC_IS_CAP) {
		redirect("/dashboard/settings/organization/members");
	}

	const query = await searchParams;
	if (query.baaRedirect === "true") {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(query)) {
			for (const entry of Array.isArray(value) ? value : [value]) {
				if (entry !== undefined) params.append(key, entry);
			}
		}
		redirect(
			`/dashboard/settings/organization/security?${params.toString()}#signed-baa`,
		);
	}

	return (
		<BillingContent
			addOns={
				<Suspense fallback={<AddOnsSummary />}>
					<AddOnsStatus />
				</Suspense>
			}
		/>
	);
}
