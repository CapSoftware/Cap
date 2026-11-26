import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	findPendingOrganizationInviteId,
	readActiveOrganizationId,
} from "@cap/database/organization-pointer";
import { userIsPro } from "@cap/utils";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthContextProvider } from "@/app/Layout/AuthContext";
import { resolveCurrentUser } from "@/app/Layout/current-user";
import { shouldOfferPasskey } from "@/lib/passkey-prompt";
import { runPromise } from "@/lib/server";
import { getShareableLinkUsage } from "@/lib/shareable-link-quota";
import DashboardInner from "./_components/DashboardInner";
import { DashboardPasteImport } from "./_components/DashboardPasteImport";
import MobileTab from "./_components/MobileTab";
import DesktopNav from "./_components/Navbar/Desktop";
import MobileNav from "./_components/Navbar/Mobile";
import { PasskeyPrompt } from "./_components/PasskeyPrompt";
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
	if (!user) redirect("/login");

	const hasName = Boolean(user.name && user.name.length > 0);
	const pendingInviteIdPromise = findPendingOrganizationInviteId(
		db(),
		user.email,
	);
	const offerPasskeyPromise = shouldOfferPasskey(user);
	const dashboardDataPromise = hasName
		? getDashboardData(user, {
				canCreatePersonalOrganization: async () =>
					!(await pendingInviteIdPromise),
			})
		: null;
	// Fail-open: the meter is informational and must never take the shell down.
	const shareableLinkUsagePromise =
		hasName && !userIsPro(user)
			? getShareableLinkUsage(user.id).catch((error) => {
					console.error("Failed to load shareable link usage", error);
					return null;
				})
			: null;

	const pendingInviteId = await pendingInviteIdPromise;
	if (pendingInviteId) redirect(`/invite/${pendingInviteId}`);

	if (!hasName || !dashboardDataPromise) {
		redirect("/onboarding/welcome");
	}

	let organizationSelect: Organization[] = [];
	let activeOrganizationId: string | null = null;
	let userCapsCount: number | null = 0;
	let organizationSettings: OrganizationSettings | null = null;
	let spacesData: Spaces[] = [];
	let anyNewNotifications = false;
	let userPreferences: UserPreferences;
	try {
		const dashboardData = await dashboardDataPromise;
		organizationSelect = dashboardData.organizationSelect;
		activeOrganizationId = dashboardData.activeOrganizationId;
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

	// The current user is cached for this request, so pages rendered with this
	// layout would still read the organization the dashboard just moved off.
	// Reloading once makes them read the stored one.
	if (
		activeOrganizationId &&
		activeOrganizationId !== user.activeOrganizationId &&
		(await readActiveOrganizationId(db(), user.id)) === activeOrganizationId
	) {
		redirect("/dashboard/caps");
	}

	const shareableLinkUsage = await shareableLinkUsagePromise;
	const offerPasskey = await offerPasskeyPromise;

	let activeOrganization = organizationSelect.find(
		(organization) =>
			organization.organization.id ===
			(activeOrganizationId ?? user.activeOrganizationId),
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
					shareableLinkUsage={shareableLinkUsage}
				>
					<DashboardPasteImport />
					{offerPasskey && <PasskeyPrompt />}
					<div className="dashboard-chrome dashboard-grid">
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
