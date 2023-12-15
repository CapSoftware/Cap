import "server-only";
import SupabaseListener from "@/utils/database/supabase/listener";
import SupabaseProvider from "@/utils/database/supabase/provider";
import "@/app/globals.css";
import { createServerClient } from "@/utils/database/supabase/server";
import type { Database } from "@/utils/database/supabase/types";
import type { SupabaseClient } from "@supabase/auth-helpers-nextjs";
import { Toaster } from "react-hot-toast";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";

export type TypedSupabaseClient = SupabaseClient<Database>;

// do not cache this layout
export const revalidate = 0;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  return (
    <html lang="en">
      <head>
        <meta property="og:image" content="https://cap.so/og.png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <link
          rel="apple-touch-icon"
          sizes="180x180"
          href="/apple-touch-icon.png"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href="/favicon-32x32.png"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="16x16"
          href="/favicon-16x16.png"
        />
        <link rel="manifest" href="/site.webmanifest" />
        <link rel="mask-icon" href="/safari-pinned-tab.svg" color="#5bbad5" />
        <meta name="msapplication-TileColor" content="#da532c" />
        <meta name="theme-color" content="#ffffff" />
      </head>
      <body>
        <SupabaseProvider session={session}>
          <SupabaseListener serverAccessToken={session?.access_token} />
          <Toaster />
          <main className="w-full overflow-hidden">
            <Navbar />
            {children}
            <Footer />
          </main>
        </SupabaseProvider>
        <script
          defer
          data-domain="cap.so"
          src="https://plausible.io/js/script.js"
        ></script>
      </body>
    </html>
  );
}
