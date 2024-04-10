"use server";
import DynamicSharedLayout from "@/app/dashboard/_components/DynamicSharedLayout";
import { getCurrentUser } from "@cap/database/auth/session";
import { redirect } from "next/navigation";
import { DashboardTemplate } from "@/components/templates/DashboardTemplate";
import { db } from "@cap/database";
import { spaceMembers, spaces } from "@cap/database/schema";
import { eq, or } from "drizzle-orm";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  const spaceSelect = await db
    .select({
      id: spaces.id,
      name: spaces.name,
      ownerId: spaces.ownerId,
      metadata: spaces.metadata,
      createdAt: spaces.createdAt,
      updatedAt: spaces.updatedAt,
    })
    .from(spaces)
    .where(or(eq(spaces.ownerId, user.id), eq(spaceMembers.userId, user.id)))
    .leftJoin(spaceMembers, eq(spaces.id, spaceMembers.spaceId));

  const activeSpace = spaceSelect.find(
    (space) => space.id === user.activeSpaceId
  );

  return (
    <DynamicSharedLayout
      spaceData={spaceSelect}
      activeSpace={activeSpace || null}
      user={user}
    >
      <div className="full-layout">
        <DashboardTemplate>{children}</DashboardTemplate>
      </div>
    </DynamicSharedLayout>
  );
}
