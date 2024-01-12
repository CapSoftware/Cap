import { cookies } from "next/headers";
import { createServerComponentClient } from "@supabase/auth-helpers-nextjs";
import type { Database } from "@cap/utils";

export const createServerClient = () =>
  createServerComponentClient<Database>(
    {
      cookies,
    },
    {
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      supabaseKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    }
  );

export const getSession = async () => {
  const supabase = createServerClient();
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return session;
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
};

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
