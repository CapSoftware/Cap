import "server-only";
import SupabaseListener from "@/utils/database/supabase/listener";
import SupabaseProvider from "@/utils/database/supabase/provider";
import "@/app/globals.css";
import { Metadata } from "next/types";
import { Toaster } from "react-hot-toast";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { createSupabaseServerClient } from "@/utils/database/supabase/server";
import { cookies } from "next/headers";

export const metadata: Metadata = {
  title: "Cap — Beautiful, shareable screen recordings",
  description: "Cap — Beautiful, shareable screen recordings",
};

// do not cache this layout
export const revalidate = 0;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createSupabaseServerClient();

  const {
    data: { session },
  } = await supabase.auth.getSession();

  return (
    <html lang="en">
      <head>
        <meta
          property="og:description"
          content="Imagine having all your messages in one place."
        />
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
          <Toaster />
          <main className="w-full overflow-hidden">
            <Navbar />
            <SupabaseListener serverAccessToken={session?.access_token} />
            {children}
            <Footer />
          </main>
        </SupabaseProvider>
      </body>
    </html>
  );
}
