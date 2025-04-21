import "@/app/globals.css";
import { BentoScript } from "@/components/BentoScript";
import { Footer } from "@/components/Footer";
import { Navbar } from "@/components/Navbar";
import { getCurrentUser } from "@cap/database/auth/session";
import crypto from "crypto";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import { Toaster } from "react-hot-toast";
import { AuthProvider } from "./AuthProvider";
import { PostHogProvider, Providers } from "./providers";
import { serverEnv } from "@cap/env";

export const metadata: Metadata = {
  title: {
    default: "OPAVC — Ontario Provincial Autism Ventures Corporation",
    template: "%s | OPAVC",
  },
  description:
    "OPAVC is dedicated to empowering individuals with autism through innovative solutions, community engagement, and sustainable ventures across Ontario.",
  openGraph: {
    title: "Ontario Provincial Autism Ventures Corporation",
    description:
      "OPAVC is dedicated to empowering individuals with autism through innovative solutions, community engagement, and sustainable ventures across Ontario.",
    url: "https://opavc.org",
    siteName: "OPAVC",
    locale: "en_CA",
    type: "website",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  twitter: {
    title: "Ontario Provincial Autism Ventures Corporation",
    card: "summary_large_image",
  },
  verification: {
    google: "google-site-verification-code", // This should be replaced with actual verification code when available
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getCurrentUser();
  const isSharePage = false;

  // Comment out Intercom hash generation
  let intercomHash = "";
  // if (serverEnv.INTERCOM_SECRET) {
  //   intercomHash = crypto
  //     .createHmac("sha256", serverEnv.INTERCOM_SECRET)
  //     .update(session?.id ?? "")
  //     .digest("hex");
  // }

  return (
    <html className={`${GeistSans.variable}`} lang="en">
      <head>
        <link
          rel="apple-touch-icon"
          sizes="180x180"
          href="/design/OPAVC-icon.png"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href="/design/OPAVC-icon.png"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="16x16"
          href="/design/OPAVC-icon.png"
        />
        <link rel="manifest" href="/site.webmanifest" />
        <link rel="mask-icon" href="/design/OPAVC Logo.svg" color="#5bbad5" />
        <link rel="shortcut icon" href="/design/OPAVC-icon.png" />
        <meta name="msapplication-TileColor" content="#da532c" />
        <meta name="theme-color" content="#ffffff" />
      </head>
      <body>
        <PostHogProvider>
          <AuthProvider>
            <Providers
              userId={session?.id}
              intercomHash={intercomHash}
              name={`${session?.name ?? ""} ${session?.lastName ?? ""}`}
              email={session?.email ?? ""}
            >
              <Toaster />
              <main className="overflow-hidden w-full">
                <Navbar auth={session ? true : false} />
                {children}
                <Footer />
              </main>
              <BentoScript user={session} />
            </Providers>
          </AuthProvider>
        </PostHogProvider>
      </body>
    </html>
  );
}
