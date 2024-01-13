"use server";

import { createServerClient } from "@supabase/ssr";
import type { Database } from "@cap/utils";
import { cookies } from "next/headers";

export async function createSupabaseServerClient() {
  const cookieStore = cookies();

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
      },
    }
  );

  return supabase;
}

export const getSession = async () => {
  const supabase = await createSupabaseServerClient();
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
  const supabase = await createSupabaseServerClient();

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
