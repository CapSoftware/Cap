import "@/app/globals.css";
import { BentoScript } from "@/components/BentoScript";
import { Footer } from "@/components/Footer";
import { Navbar } from "@/components/Navbar";
import { getCurrentUser } from "@cap/database/auth/session";
import { serverEnv } from "@cap/env";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import crypto from "crypto";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { Toaster } from "react-hot-toast";
import { AuthProvider } from "./AuthProvider";
import { PostHogProvider, Providers } from "./providers";

export const metadata: Metadata = {
  title: "Cap — Beautiful screen recordings, owned by you.",
  description:
    "Cap is the open source alternative to Loom. Lightweight, powerful, and cross-platform. Record and share in seconds.",
  openGraph: {
    title: "Cap — Beautiful screen recordings, owned by you.",
    description:
      "Cap is the open source alternative to Loom. Lightweight, powerful, and cross-platform. Record and share in seconds.",
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
  let intercomHash = "";
  if (serverEnv.INTERCOM_SECRET) {
    intercomHash = crypto
      .createHmac("sha256", serverEnv.INTERCOM_SECRET)
      .update(user?.id ?? "")
      .digest("hex");
  }

  const path = headers().get("x-current-path");
  const isPathDashboard =
    path?.startsWith("/dashboard") ||
    path?.startsWith("/login") ||
    path?.startsWith("/onboarding");

  const cookieStore = await cookies();
  const theme = cookieStore.get("theme")?.value === "dark" ? "dark" : "light";

  return (
    <html lang="en">
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
      <body className={isPathDashboard ? theme : "light"}>
        <TooltipPrimitive.Provider>
          <PostHogProvider>
            <AuthProvider>
              <Providers
                userId={user?.id}
                intercomHash={intercomHash}
                name={`${user?.name ?? ""} ${user?.lastName ?? ""}`}
                email={user?.email ?? ""}
              >
                <Toaster />
                <main className="overflow-x-hidden w-full">
                  <Navbar auth={user ? true : false} />
                  {children}
                  <Footer />
                </main>
                <BentoScript user={user} />
              </Providers>
            </AuthProvider>
          </PostHogProvider>
        </TooltipPrimitive.Provider>
      </body>
    </html>
  );
}
