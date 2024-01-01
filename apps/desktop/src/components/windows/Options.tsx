import { Recorder } from "@/components/windows/inner/Recorder";
import { SignIn } from "@/components/windows/inner/SignIn";
import { supabase } from "@/utils/database/client";
import { AuthSession } from "@supabase/supabase-js";
import { UnlistenFn, listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

export const Options = () => {
  const [session, setSession] = useState<AuthSession | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    let unlistenFn: UnlistenFn | undefined;

    const setupEventListener = async () => {
      unlistenFn = await listen("video-uploaded", async (event) => {
        console.log("video-uploaded event received:", event);

        const { data, error } = await supabase
          .from("videos")
          .insert([
            { unique_cap_id: event.payload, owner_id: session?.user?.id },
          ]);

        if (error) {
          console.error("Error inserting video:", error);
        } else {
          console.log("Video inserted:", data);
        }
      });
    };

    setupEventListener();
  }, []);

  console.log("session:");
  console.log(session);

  if (session) {
    return <Recorder session={session} />;
  }

  return <SignIn />;
};
