import "server-only";
import DynamicSharedLayout from "@/app/dashboard/_components/DynamicSharedLayout";
import {
  createServerClient,
  getActiveSpace,
} from "@/utils/database/supabase/server";

export const revalidate = 0;

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createServerClient();
  const spaceData = await supabase
    .from("spaces")
    .select("*")
    .order("created_at", { ascending: true });
  const activeSpace = await getActiveSpace();

  return (
    <DynamicSharedLayout spaceData={spaceData?.data} activeSpace={activeSpace}>
      <div className="full-layout">{children}</div>
    </DynamicSharedLayout>
  );
}
