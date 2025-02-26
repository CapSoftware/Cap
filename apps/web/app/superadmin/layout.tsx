import DynamicSharedLayout from "@/app/dashboard/_components/DynamicSharedLayout";
import { getCurrentUser } from "@cap/database/auth/session";
import { redirect } from "next/navigation";
import { DashboardTemplate } from "@/components/templates/DashboardTemplate";
import { db } from "@cap/database";
import {
  spaceMembers,
  spaces,
  spaceInvites,
  users,
} from "@cap/database/schema";
import { eq, inArray, or, and, count, sql } from "drizzle-orm";
import {
  addServerSuperAdmin,
  getServerConfig,
} from "@/utils/instance/functions";

export default async function SuperAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  if (!user || !user.id) {
    redirect("/login");
  }

  const serverConfig = await getServerConfig();

  const serverSuperAdminIds = serverConfig?.superAdminIds;

  if (serverSuperAdminIds && !serverSuperAdminIds.includes(user.id)) {
    redirect("/dashboard");
  }

  if (!serverSuperAdminIds) {
    await addServerSuperAdmin({ userId: user.id });
  }

  return (
    <DynamicSharedLayout
      spaceData={spaceSelect}
      activeSpace={findActiveSpace || null}
      user={user}
      isSubscribed={isSubscribed}
    >
      <div className="full-layout">
        <DashboardTemplate>{children}</DashboardTemplate>
      </div>
    </DynamicSharedLayout>
  );
}
