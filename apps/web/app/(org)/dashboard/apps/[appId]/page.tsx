import { getCurrentUser } from "@cap/database/auth/session";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { userOrganizations } from "@/lib/app-store/access";
import { getCatalogApp } from "@/lib/app-store/catalog";
import { listInstallations } from "@/lib/app-store/installations";
import { canManageOrganizationSettings } from "@/lib/permissions/roles";
import { AppDetail } from "../_components/AppDetail";

export async function generateMetadata({
	params,
}: {
	params: Promise<{ appId: string }>;
}): Promise<Metadata> {
	const { appId } = await params;
	const app = getCatalogApp(appId);
	return { title: app ? `${app.name} | Cap Apps` : "Apps | Cap" };
}

export default async function AppDetailPage({
	params,
}: {
	params: Promise<{ appId: string }>;
}) {
	const { appId } = await params;
	const app = getCatalogApp(appId);
	if (!app) notFound();

	const user = await getCurrentUser();
	if (!user) redirect("/login");

	const [installations, organizations] = await Promise.all([
		listInstallations(user.id),
		userOrganizations(user.id),
	]);

	return (
		<AppDetail
			app={app}
			installations={installations.filter(
				(installation) => installation.appId === app.id,
			)}
			organizations={organizations.map((organization) => ({
				id: organization.id,
				name: organization.name,
				canManage: canManageOrganizationSettings(organization.role),
				adminsOnly: organization.adminsOnly,
			}))}
			activeOrganizationId={user.activeOrganizationId ?? null}
		/>
	);
}
