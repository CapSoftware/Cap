"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { supabase } from "@/utils/database/supabase/client";

// this component handles refreshing server data when the user logs in or out
// this method avoids the need to pass a session down to child components
// in order to re-render when the user's session changes
// #elegant!
export default function SupabaseListener({
  serverAccessToken,
}: {
  serverAccessToken?: string;
}) {
  const router = useRouter();

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(
      (_event: AuthChangeEvent, session: Session | null) => {
        if (session?.access_token !== serverAccessToken) {
          // server and client are out of sync
          // reload the page to fetch fresh server data
          // https://beta.nextjs.org/docs/data-fetching/mutating
          router.refresh();
        }
      }
    );

    return () => {
      subscription.unsubscribe();
    };
  }, [serverAccessToken, router, supabase]);

  return null;
}
