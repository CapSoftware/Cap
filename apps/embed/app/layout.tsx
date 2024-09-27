import "@/app/globals.css";
import { Toaster } from "react-hot-toast";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Cap — Beautiful, shareable screen recordings.",
  description:
    "Cap is the open source alternative to Loom. Lightweight, powerful, and stunning. Record and share in seconds.",
  openGraph: {
    title: "Cap — Beautiful, shareable screen recordings.",
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
      <body className="w-screen h-screen">
        <Toaster />
        <main className="w-full h-full overflow-hidden">{children}</main>
      </body>
    </html>
  );
}
