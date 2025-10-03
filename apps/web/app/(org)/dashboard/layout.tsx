import { getCurrentUser } from "@cap/database/auth/session";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import DashboardInner from "./_components/DashboardInner";
import DesktopNav from "./_components/Navbar/Desktop";
import MobileNav from "./_components/Navbar/Mobile";
import { DashboardContexts } from "./Contexts";
import { UploadingProvider } from "./caps/UploadingContext";
import {
	getDashboardData,
	type Organization,
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
	let spacesData: Spaces[] = [];
	let anyNewNotifications = false;
	let userPreferences: UserPreferences;
	try {
		const dashboardData = await getDashboardData(user);
		organizationSelect = dashboardData.organizationSelect;
		userPreferences = dashboardData.userPreferences?.preferences || null;
		spacesData = dashboardData.spacesData;
		anyNewNotifications = dashboardData.anyNewNotifications;
	} catch (error) {
		console.error("Failed to load dashboard data", error);
		organizationSelect = [];
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

	const theme = cookies().get("theme")?.value ?? "light";
	const sidebar = cookies().get("sidebarCollapsed")?.value ?? "false";

	return (
		<UploadingProvider>
			<DashboardContexts
				organizationData={organizationSelect}
				activeOrganization={activeOrganization || null}
				spacesData={spacesData}
				user={user}
				isSubscribed={isSubscribed}
				initialTheme={theme as "light" | "dark"}
				initialSidebarCollapsed={sidebar === "true"}
				anyNewNotifications={anyNewNotifications}
				userPreferences={userPreferences}
			>
				<div className="grid grid-cols-[auto,1fr] overflow-y-auto bg-gray-1 grid-rows-[auto,1fr] h-dvh min-h-dvh">
					<aside className="z-10 col-span-1 row-span-2">
						<DesktopNav />
					</aside>
					<div className="flex col-span-1 row-span-2 h-full custom-scroll focus:outline-none">
						<MobileNav />
						<div className="dashboard-page">
							<DashboardInner>{children}</DashboardInner>
						</div>
					</div>
				</div>
			</DashboardContexts>
		</UploadingProvider>
	);
}
