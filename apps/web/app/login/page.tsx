"use client";

import { useSupabase } from "@/utils/database/supabase/provider";
import { LogoBadge } from "@cap/ui";
import { Auth } from "@supabase/auth-ui-react";
import { ThemeSupa } from "@supabase/auth-ui-shared";
import { useRouter } from "next/navigation";

export default function AuthUI() {
  const { supabase, session } = useSupabase();
  const router = useRouter();

  if (session) {
    router.replace("/dashboard/caps");
  }

  return (
    <div>
      <div className="w-full h-full min-h-screen flex items-center relative">
        <div className="wrapper text-center">
          <div className="max-w-md mx-auto animate-fadeinfast overflow-hidden">
            <div className="bg-white p-10 space-y-6 text-sm">
              <div>
                <a href="/">
                  <LogoBadge className="h-16 w-auto mx-auto mb-3" />
                </a>
                <h1 className="text-3xl">Sign in to Cap</h1>
              </div>
              <div className="flex flex-col space-y-4">
                <Auth
                  supabaseClient={supabase}
                  view="magic_link"
                  providers={[]}
                  redirectTo={`${process.env.NEXT_PUBLIC_URL}/auth/callback`}
                  magicLink={true}
                  appearance={{
                    theme: ThemeSupa,
                    variables: {
                      default: {
                        colors: {
                          brand: "var(--primary)",
                          brandAccent: "var(--primary-2)",
                        },
                        fonts: {
                          bodyFontFamily: "var(--font-primary)",
                          buttonFontFamily: "var(--font-primary)",
                          inputFontFamily: "var(--font-primary)",
                          labelFontFamily: "var(--font-primary)",
                        },
                      },
                    },
                  }}
                  theme="default"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
