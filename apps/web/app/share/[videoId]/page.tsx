"use server";
import { Share } from "./Share";
// import { createSupabaseServerClient } from "@/utils/database/supabase/server";
import { uuidFormat } from "@cap/utils";

type Props = {
  params: { [key: string]: string | string[] | undefined };
};

//TODO: Auth

export default async function ShareVideoPage(props: Props) {
  // const supabase = await createSupabaseServerClient();
  const params = props.params;
  const videoId = uuidFormat(params.videoId as string);

  // const video = await supabase.from("videos").select("*").eq("id", videoId);

  return <Share data={null} />;
}
