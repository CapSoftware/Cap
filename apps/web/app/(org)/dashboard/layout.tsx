import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizationInvites } from "@cap/database/schema";
import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthContextProvider } from "@/app/Layout/AuthContext";
import { resolveCurrentUser } from "@/app/Layout/current-user";
import { runPromise } from "@/lib/server";
import DashboardInner from "./_components/DashboardInner";
import { DashboardPasteImport } from "./_components/DashboardPasteImport";
import MobileTab from "./_components/MobileTab";
import DesktopNav from "./_components/Navbar/Desktop";
import MobileNav from "./_components/Navbar/Mobile";
import { DashboardContexts } from "./Contexts";
import { UploadingProvider } from "./caps/UploadingContext";
import {
	getDashboardData,
	type Organization,
	type OrganizationSettings,
	type Spaces,
	type UserPreferences,
} from "./dashboard-data";

export const dynamic = "force-dynamic";

async function getPendingInviteIdForUser(email: string) {
	const [invite] = await db()
		.select({ id: organizationInvites.id })
		.from(organizationInvites)
		.where(
			and(
				eq(organizationInvites.invitedEmail, email.toLowerCase()),
				eq(organizationInvites.status, "pending"),
			),
		)
		.limit(1);

	return invite?.id ?? null;
}

export default async function DashboardLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const user = await getCurrentUser();
	if (!user) redirect("/login");

	const pendingInviteId = await getPendingInviteIdForUser(user.email);
	if (pendingInviteId) redirect(`/invite/${pendingInviteId}`);

	if (!user.name || user.name.length === 0) {
		redirect("/onboarding/welcome");
	}

	let organizationSelect: Organization[] = [];
	let userCapsCount: number | null = 0;
	let organizationSettings: OrganizationSettings | null = null;
	let spacesData: Spaces[] = [];
	let anyNewNotifications = false;
	let userPreferences: UserPreferences;
	try {
		const dashboardData = await getDashboardData(user);
		organizationSelect = dashboardData.organizationSelect;
		userCapsCount = dashboardData.userCapsCount;
		organizationSettings = dashboardData.organizationSettings;
		userPreferences = dashboardData.userPreferences?.preferences || null;
		spacesData = dashboardData.spacesData;
		anyNewNotifications = dashboardData.anyNewNotifications;
	} catch (error) {
		console.error("Failed to load dashboard data", error);
		organizationSelect = [];
		userCapsCount = 0;
		organizationSettings = null;
		spacesData = [];
		anyNewNotifications = false;
		userPreferences = null;
	}

	let activeOrganization = organizationSelect.find(
		(organization) =>
			organization.organization.id === user.activeOrganizationId,
	);

	if (!activeOrganization && organizationSelect.length > 0) {
		activeOrganization = organizationSelect[0];
	}

	const theme = (await cookies()).get("theme")?.value ?? "light";
	const sidebar = (await cookies()).get("sidebarCollapsed")?.value ?? "false";
	const referClicked = (await cookies()).get("referClicked")?.value ?? "false";

	return (
		<AuthContextProvider user={runPromise(resolveCurrentUser)}>
			<UploadingProvider>
				<DashboardContexts
					organizationSettings={organizationSettings}
					userCapsCount={userCapsCount}
					organizationData={organizationSelect}
					activeOrganization={activeOrganization || null}
					spacesData={spacesData}
					initialTheme={theme as "light" | "dark"}
					initialSidebarCollapsed={sidebar === "true"}
					anyNewNotifications={anyNewNotifications}
					userPreferences={userPreferences}
					referClicked={referClicked === "true"}
				>
					<DashboardPasteImport />
					<div className="bg-gray-2 dashboard-grid">
						<DesktopNav />
						<div className="flex h-full [grid-area:main] focus:outline-none">
							<MobileNav />
							<DashboardInner>{children}</DashboardInner>
						</div>
						<MobileTab />
					</div>
				</DashboardContexts>
			</UploadingProvider>
		</AuthContextProvider>
	);
}
