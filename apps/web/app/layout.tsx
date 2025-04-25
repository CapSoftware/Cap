import "@/app/globals.css";
import { BentoScript } from "@/components/BentoScript";
import { Footer } from "@/components/Footer";
import { Navbar } from "@/components/Navbar";
import { getCurrentUser } from "@cap/database/auth/session";
import { serverEnv } from "@cap/env";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import crypto from "crypto";
import type { Metadata } from "next";
import localFont from "next/font/local";
import { Toaster } from "react-hot-toast";
import { AuthProvider } from "./AuthProvider";
import { PostHogProvider, Providers } from "./providers";
import { PublicEnvContext } from "@/utils/public-env";
import { S3_BUCKET_URL } from "@cap/utils";

const SfProDisplay = localFont({
  src: [
    {
      path: "./fonts/SFPRODISPLAYREGULAR.woff2",
      weight: "300",
    },
    {
      path: "./fonts/SFPRODISPLAYBOLD.woff2",
      weight: "700",
    },
    {
      path: "./fonts/SFPRODISPLAYMEDIUM.woff2",
      weight: "500",
    },
  ],
  display: "swap",
  variable: "--font-sf-pro-display",
});

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
      <body>
        <TooltipPrimitive.Provider>
          <PostHogProvider>
            <AuthProvider>
              <PublicEnvContext
                value={{
                  webUrl: serverEnv.WEB_URL,
                  awsBucket: serverEnv.CAP_AWS_BUCKET,
                  s3BucketUrl: S3_BUCKET_URL,
                }}
              >
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
              </PublicEnvContext>
            </AuthProvider>
          </PostHogProvider>
        </TooltipPrimitive.Provider>
      </body>
    </html>
  );
}
