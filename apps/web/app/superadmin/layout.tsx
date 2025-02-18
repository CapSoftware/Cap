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

export default async function SuperAdminLayout({
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
