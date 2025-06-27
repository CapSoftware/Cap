import { getCurrentUser } from "@cap/database/auth/session";
import { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardData } from "../../dashboard-data";
import { Organization } from "./Organization";

export const metadata: Metadata = {
  title: "Organization Settings — Cap",
};

export const revalidate = 0;

export default async function OrganizationPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/auth/signin");
  }

  const dashboardData = await getDashboardData(user);
  const isOwner = dashboardData.organizationSelect.find(
    (organization) => organization.organization.ownerId === user.id
  );

  if (!isOwner) {
    redirect("/dashboard/caps");
  }

  return <Organization />;
}
