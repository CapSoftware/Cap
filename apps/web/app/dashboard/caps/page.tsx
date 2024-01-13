import "server-only";
import { Caps } from "./Caps";
import { DashboardTemplate } from "@/components/templates/DashboardTemplate";
import { createSupabaseServerClient } from "@/utils/database/supabase/server";

export const revalidate = 0;

type Props = {
  params: { [key: string]: string | string[] | undefined };
};

export default async function DocumentsPage(props: Props) {
  const supabase = await createSupabaseServerClient();
  const caps = await supabase
    .from("videos")
    .select("*")
    .order("created_at", { ascending: true });

  return (
    <DashboardTemplate>
      <Caps data={caps?.data} />
    </DashboardTemplate>
  );
}
