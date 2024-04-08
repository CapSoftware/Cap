"use server";
import DynamicSharedLayout from "@/app/dashboard/_components/DynamicSharedLayout";
import { getCurrentUser } from "@cap/database/auth/session";
import { redirect } from "next/navigation";
import { DashboardTemplate } from "@/components/templates/DashboardTemplate";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }
  return (
    <DynamicSharedLayout spaceData={null} activeSpace={null} user={user}>
      <div className="full-layout">
        <DashboardTemplate>{children}</DashboardTemplate>
      </div>
    </DynamicSharedLayout>
  );
}
