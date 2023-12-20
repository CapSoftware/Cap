import { cookies } from "next/headers";
import {
  createServerComponentClient,
  createRouteHandlerClient,
} from "@supabase/auth-helpers-nextjs";
import { Database } from "./types";

export const createServerClient = () =>
  createServerComponentClient<Database>({
    cookies,
  });

export const createRouteClient = () =>
  createRouteHandlerClient<Database>({
    cookies,
  });

export const getActiveSpace = async () => {
  const supabase = createServerClient();

  const { data: userData, error: userError } = await supabase
    .from("users")
    .select("active_space_id")
    .single();

  if (userError) {
    console.error(userError);
    return null;
  }

  let spaceId = userData?.active_space_id;

  // If there's no active space set, we need to find the first available space
  if (!spaceId) {
    const { data: firstSpace, error: firstSpaceError } = await supabase
      .from("spaces")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    if (firstSpaceError) {
      console.error(firstSpaceError);
      return null;
    }

    spaceId = firstSpace?.id;
  }

  if (!spaceId) {
    // If we still don't have a space ID, it means there are no spaces available
    return null;
  }

  // Now retrieve the full details of the active space
  const { data: spaceData, error: spaceError } = await supabase
    .from("spaces")
    .select("*")
    .eq("id", spaceId)
    .single();

  if (spaceError) {
    console.error(spaceError);
    return null;
  }

  return spaceData;
};
