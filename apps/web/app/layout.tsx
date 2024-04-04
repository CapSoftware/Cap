import "@/app/globals.css";
import { Toaster } from "react-hot-toast";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import type { Metadata } from "next";
import { getCurrentUser } from "@cap/database/auth/session";

export const metadata: Metadata = {
  title:
    "Cap — Effortless, instant screen sharing. Open source and cross-platform.",
  description:
    "Cap is the open source alternative to Loom. Lightweight, powerful, and stunning. Record and share in seconds.",
  openGraph: {
    title:
      "Cap — Effortless, instant screen sharing. Open source and cross-platform.",
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
        <script
          defer
          data-domain="cap.so"
          src="https://plausible.io/js/script.js"
        ></script>
      </body>
    </html>
  );
}
