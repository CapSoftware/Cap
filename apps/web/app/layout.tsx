import "@/app/globals.css";
import { SonnerToaster } from "@/components/SonnerToastProvider";
import { PublicEnvContext } from "@/utils/public-env";
import { buildEnv } from "@cap/env";
import { S3_BUCKET_URL } from "@cap/utils";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { Metadata } from "next";
import { PropsWithChildren } from "react";
import { getBootstrapData } from "@/utils/getBootstrapData";

import {
  SessionProvider,
  PostHogProvider,
  ReactQueryProvider,
} from "./Layout/providers";

//@ts-expect-error
import { script } from "./themeScript";
import { getCurrentUser } from "@cap/database/auth/session";
import { AuthContextProvider } from "./Layout/AuthContext";
import { Intercom } from "./Layout/Intercom";
import { PosthogIdentify } from "./Layout/PosthogIdentify";

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

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: PropsWithChildren) {
  const bootstrapData = await getBootstrapData();
  const userPromise = getCurrentUser();

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
          <PostHogProvider bootstrapData={bootstrapData}>
            <AuthContextProvider user={userPromise}>
              <SessionProvider>
                <PublicEnvContext
                  value={{
                    webUrl: buildEnv.NEXT_PUBLIC_WEB_URL,
                    awsBucket: buildEnv.NEXT_PUBLIC_CAP_AWS_BUCKET,
                    s3BucketUrl: S3_BUCKET_URL,
                  }}
                >
                  <ReactQueryProvider>
                    <SonnerToaster />
                    <main className="overflow-x-hidden w-full">{children}</main>
                    <PosthogIdentify />
                  </ReactQueryProvider>
                </PublicEnvContext>
              </SessionProvider>
            </AuthContextProvider>
          </PostHogProvider>
        </TooltipPrimitive.Provider>
      </body>
    </html>
  );
}
