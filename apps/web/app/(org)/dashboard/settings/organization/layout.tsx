import { getCurrentUser } from "@cap/database/auth/session";
import { Card, CardDescription, CardHeader, CardTitle } from "@cap/ui";
import { redirect } from "next/navigation";
import { getOrganizationAccess } from "@/actions/organization/authorization";
import { canViewOrganizationSettings } from "@/lib/permissions/roles";
import { SettingsNav } from "./_components/SettingsNav";

export default async function OrganizationSettingsLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const user = await getCurrentUser();

	if (!user) {
		redirect("/auth/signin");
	}

	if (!user.activeOrganizationId) {
		redirect("/dashboard/caps");
	}

	const access = await getOrganizationAccess(
		user.id,
		user.activeOrganizationId,
	);

	if (!access || !canViewOrganizationSettings(access.role)) {
		return (
			<div className="flex flex-col gap-6">
				<Card>
					<CardHeader>
						<CardTitle>Organization settings are restricted</CardTitle>
						<CardDescription>
							Ask an admin or owner to make the change.
						</CardDescription>
					</CardHeader>
				</Card>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-6">
			<SettingsNav />
			{children}
		</div>
	);
}
