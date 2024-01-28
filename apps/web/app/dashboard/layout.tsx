"use server";
import DynamicSharedLayout from "@/app/dashboard/_components/DynamicSharedLayout";
// import {
//   createSupabaseServerClient,
//   getSession,
//   getActiveSpace,
// } from "@/utils/database/supabase/server";
// import SupabaseProvider from "@/utils/database/supabase/provider";
// import SupabaseListener from "@/utils/database/supabase/listener";
import { getCurrentUser } from "@cap/database/auth/session";
import { redirect } from "next/navigation";
import { DashboardTemplate } from "@/components/templates/DashboardTemplate";

//TODO: Auth

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getCurrentUser();

  if (!session) {
    redirect("/login");
  }

  // const supabase = await createSupabaseServerClient();
  // const spaceData = await supabase
  //   .from("spaces")
  //   .select("*")
  //   .order("created_at", { ascending: true });
  // const activeSpace = await getActiveSpace();
  // const session = await getSession();

  // console.log("session", session);

  return (
    <DynamicSharedLayout spaceData={null} activeSpace={null}>
      <div className="full-layout">
        <DashboardTemplate>{children}</DashboardTemplate>
      </div>
    </DynamicSharedLayout>
  );
}
