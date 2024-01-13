import "server-only";
import { Share } from "./Share";
import { createSupabaseServerClient } from "@/utils/database/supabase/server";
import { uuidFormat } from "@cap/utils";

export const revalidate = 0;

type Props = {
  params: { [key: string]: string | string[] | undefined };
};

export default async function ShareVideoPage(props: Props) {
  const supabase = await createSupabaseServerClient();
  const params = props.params;
  const videoId = uuidFormat(params.videoId as string);

  const video = await supabase.from("videos").select("*").eq("id", videoId);

  console.log(video);

  return <Share data={video?.data ? video?.data[0] : null} />;
}
