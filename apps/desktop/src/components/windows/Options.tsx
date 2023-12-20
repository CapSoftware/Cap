import { Recorder } from "@/components/windows/inner/Recorder";
import { SignIn } from "@/components/windows/inner/SignIn";
import { setWindowPosition } from "@/utils/helpers";
import { supabase } from "@/utils/database/client";
import { AuthSession } from "@supabase/supabase-js";
import { useEffect, useState } from "react";

export const Options = () => {
  setWindowPosition("bottom_center");

  const [session, setSession] = useState<AuthSession | null>(null);
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });
  }, []);

  if (session) {
    return <Recorder />;
  }

  return <SignIn />;
};
