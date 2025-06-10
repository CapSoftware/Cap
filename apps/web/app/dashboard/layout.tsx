import DynamicSharedLayout from "@/app/dashboard/_components/DynamicSharedLayout";
import { DashboardTemplate } from "@/components/templates/DashboardTemplate";
import { getCurrentUser } from "@cap/database/auth/session";
import { getDashboardData, Organization, Spaces } from "./dashboard-data";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

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

  if (!user.name || user.name.length <= 1) {
    redirect("/onboarding");
  }

  let organizationSelect: Organization[] = [];
  let spacesData: Spaces[] = [];
  try {
    const dashboardData = await getDashboardData(user);
    organizationSelect = dashboardData.organizationSelect;
    spacesData = dashboardData.spacesData;
  } catch (error) {
    console.error("Failed to load dashboard data", error);
    organizationSelect = [];
    spacesData = [];
  }

  let activeOrganization = organizationSelect.find(
    (organization) => organization.organization.id === user.activeOrganizationId
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
    <DynamicSharedLayout
      organizationData={organizationSelect}
      activeOrganization={activeOrganization || null}
      spacesData={spacesData}
      user={user}
      isSubscribed={isSubscribed}
      initialTheme={theme as "light" | "dark"}
      initialSidebarCollapsed={sidebar === "true"}
    >
      <DashboardTemplate>{children}</DashboardTemplate>
    </DynamicSharedLayout>
  );
}
