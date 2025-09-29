import { getCurrentUser } from "@cap/database/auth/session";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import DashboardInner from "./_components/DashboardInner";
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

export default async function DashboardLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const user = await getCurrentUser();

	if (!user || !user.id) {
		redirect("/login");
	}

	if (!user.name || user.name.length === 0) {
		redirect("/onboarding");
	}

	let organizationSelect: Organization[] = [];
	let organizationSettings: OrganizationSettings = null;
	let spacesData: Spaces[] = [];
	let anyNewNotifications = false;
	let userPreferences: UserPreferences;
	try {
		const dashboardData = await getDashboardData(user);
		organizationSelect = dashboardData.organizationSelect;
		organizationSettings = dashboardData.organizationSettings;
		userPreferences = dashboardData.userPreferences?.preferences || null;
		spacesData = dashboardData.spacesData;
		anyNewNotifications = dashboardData.anyNewNotifications;
	} catch (error) {
		console.error("Failed to load dashboard data", error);
		organizationSelect = [];
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

	const isSubscribed =
		(user.stripeSubscriptionId &&
			user.stripeSubscriptionStatus !== "cancelled") ||
		!!user.thirdPartyStripeSubscriptionId;

	const theme = (await cookies()).get("theme")?.value ?? "light";
	const sidebar = (await cookies()).get("sidebarCollapsed")?.value ?? "false";
	const referClicked = (await cookies()).get("referClicked")?.value ?? "false";

	console.log(organizationSettings, "organizationSettings");

	return (
		<UploadingProvider>
			<DashboardContexts
				organizationSettings={organizationSettings}
				organizationData={organizationSelect}
				activeOrganization={activeOrganization || null}
				spacesData={spacesData}
				user={user}
				isSubscribed={isSubscribed}
				initialTheme={theme as "light" | "dark"}
				initialSidebarCollapsed={sidebar === "true"}
				anyNewNotifications={anyNewNotifications}
				userPreferences={userPreferences}
				referClicked={referClicked === "true"}
			>
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
	);
}
