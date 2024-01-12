import "server-only";
import { createServerClient } from "@/utils/database/supabase/server";
import { Share } from "./Share";
import { uuidFormat } from "@cap/utils";

export const revalidate = 0;

type Props = {
  params: { [key: string]: string | string[] | undefined };
};

export default async function ShareVideoPage(props: Props) {
  const params = props.params;
  const supabase = createServerClient();

  const video = await supabase
    .from("videos")
    .select("*")
    .eq("id", "6e3ae508-f661-4547-948b-d7b06c9bb752");

  console.log(video);

  return <Share data={video?.data ? video?.data[0] : null} />;
}
