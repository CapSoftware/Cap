import "server-only";
import {
  createServerClient,
  getActiveSpace,
} from "@/utils/database/supabase/server";
import { Caps } from "./Caps";
import { DashboardTemplate } from "@/components/templates/DashboardTemplate";

export const revalidate = 0;

type Props = {
  params: { [key: string]: string | string[] | undefined };
};

export default async function DocumentsPage(props: Props) {
  const supabase = createServerClient();
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
