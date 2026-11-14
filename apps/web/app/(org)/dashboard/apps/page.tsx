import { getCurrentUser } from "@cap/database/auth/session";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { userOrganizations } from "@/lib/app-store/access";
import { getAppStoreCatalog } from "@/lib/app-store/catalog";
import { listInstallations } from "@/lib/app-store/installations";
import { canManageOrganizationSettings } from "@/lib/permissions/roles";
import { AppStoreBrowser } from "./_components/AppStoreBrowser";
import { toListing } from "./_components/types";

export const metadata: Metadata = {
	title: "Apps | Cap",
};

export default async function AppsPage() {
	const user = await getCurrentUser();
	if (!user) redirect("/login");

	const [installations, organizations] = await Promise.all([
		listInstallations(user.id),
		userOrganizations(user.id),
	]);
	const active = organizations.find(
		(organization) => organization.id === user.activeOrganizationId,
	);

	return (
		<AppStoreBrowser
			apps={getAppStoreCatalog().apps.map(toListing)}
			installations={installations}
			activeOrganization={
				active
					? {
							id: active.id,
							name: active.name,
							canManage: canManageOrganizationSettings(active.role),
							adminsOnly: active.adminsOnly,
						}
					: null
			}
		/>
	);
}
