import { getCurrentUser } from "@cap/database/auth/session";
import { buildEnv } from "@cap/env";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getInvoiceHistory } from "@/actions/billing/invoices";
import { getOrganizationAccess } from "@/actions/organization/authorization";
import { canViewOrganizationSettings } from "@/lib/permissions/roles";
import { SettingsNav } from "../organization/_components/SettingsNav";
import { InvoiceHistory } from "./invoice-history";

export const metadata: Metadata = { title: "Invoices — Cap" };

export default async function InvoicesPage() {
	const user = await getCurrentUser();
	if (!user) redirect("/auth/signin");
	if (!buildEnv.NEXT_PUBLIC_IS_CAP) redirect("/dashboard/settings/account");
	const [history, access] = await Promise.all([
		getInvoiceHistory().catch(() => null),
		user.activeOrganizationId
			? getOrganizationAccess(user.id, user.activeOrganizationId)
			: null,
	]);
	return (
		<div className="flex flex-col gap-6">
			{access && canViewOrganizationSettings(access.role) && <SettingsNav />}
			<InvoiceHistory initialHistory={history} />
		</div>
	);
}
