import "server-only";
import DynamicSharedLayout from "@/app/dashboard/_components/DynamicSharedLayout";
import {
  createSupabaseServerClient,
  getSession,
  getActiveSpace,
} from "@/utils/database/supabase/server";

export const revalidate = 0;

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createSupabaseServerClient();
  const spaceData = await supabase
    .from("spaces")
    .select("*")
    .order("created_at", { ascending: true });
  const activeSpace = await getActiveSpace();
  const session = await getSession();

  console.log("session", session);

  return (
    <DynamicSharedLayout spaceData={spaceData?.data} activeSpace={activeSpace}>
      <div className="full-layout">{children}</div>
    </DynamicSharedLayout>
  );
}
