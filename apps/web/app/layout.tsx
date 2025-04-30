import "@/app/globals.css";
import { BentoScript } from "@/components/BentoScript";
import { Footer } from "@/components/Footer";
import { Navbar } from "@/components/Navbar";
import { getCurrentUser } from "@cap/database/auth/session";
import { buildEnv, serverEnv } from "@cap/env";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { Metadata } from "next";
import { Toaster } from "react-hot-toast";
import { AuthProvider } from "./AuthProvider";
import { PostHogProvider, Providers } from "./providers";
import { PublicEnvContext } from "@/utils/public-env";
import { S3_BUCKET_URL } from "@cap/utils";
import { PropsWithChildren } from "react";
import crypto from "crypto";
//@ts-expect-error
import { script } from "./themeScript";

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

export default async function RootLayout({ children }: PropsWithChildren) {
  const user = await getCurrentUser();
  const intercomSecret = serverEnv().INTERCOM_SECRET;
  let intercomHash = "";
  if (intercomSecret) {
    intercomHash = crypto
      .createHmac("sha256", intercomSecret)
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
      <body suppressHydrationWarning>
        <script
          dangerouslySetInnerHTML={{ __html: `(${script.toString()})()` }}
        />
        <TooltipPrimitive.Provider>
          <PostHogProvider>
            <AuthProvider>
              <PublicEnvContext
                value={{
                  webUrl: buildEnv.NEXT_PUBLIC_WEB_URL,
                  awsBucket: buildEnv.NEXT_PUBLIC_CAP_AWS_BUCKET,
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
