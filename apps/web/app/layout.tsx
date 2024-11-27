import "@/app/globals.css";
import { Toaster } from "react-hot-toast";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import type { Metadata } from "next";
import { getCurrentUser } from "@cap/database/auth/session";
import { BentoScript } from "@/components/BentoScript";
import { CSPostHogProvider } from "./providers";
import Intercom from "@intercom/messenger-js-sdk";

export const metadata: Metadata = {
  title: "Cap — Beautiful screen recordings, owned by you.",
  description:
    "Cap is the open source alternative to Loom. Lightweight, powerful, and stunning. Record and share in seconds.",
  openGraph: {
    title: "Cap — Beautiful screen recordings, owned by you.",
    description:
      "Cap is the open source alternative to Loom. Lightweight, powerful, and stunning. Record and share in seconds.",
    type: "website",
    url: "https://cap.so",
    images: ["https://cap.so/og.png"],
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  Intercom({
    app_id: "efxq71cv",
    user_id: user?.id ?? "",
    name: user?.name ?? "",
    email: user?.email ?? "",
    created_at: user?.created_at
      ? new Date(user.created_at).getTime() / 1000
      : 0,
  });

  return (
    <html lang="en">
      <CSPostHogProvider>
        <head>
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
          <link rel="shortcut icon" href="/favicon.ico" />
          <meta name="msapplication-TileColor" content="#da532c" />
          <meta name="theme-color" content="#ffffff" />
        </head>
        <body>
          <Toaster />
          <main className="w-full overflow-hidden">
            <Navbar auth={user ? true : false} />
            {children}
            <Footer />
          </main>
          <BentoScript user={user} />
        </body>
      </CSPostHogProvider>
    </html>
  );
}
