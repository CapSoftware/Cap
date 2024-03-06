"use client";
import "./styles.css";
import { MediaDeviceProvider } from "@/utils/recording/MediaDeviceContext";
import { Toaster } from "react-hot-toast";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <meta property="og:title" content="Cap Desktop App" />
        <meta
          property="og:description"
          content="Cap is an open source and privacy focused alternative to Loom. It's a video messaging tool that allows you to record, edit and share videos in seconds."
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
        <title>Cap Desktop App</title>
      </head>
      <body>
        <Toaster />
        <MediaDeviceProvider>{children}</MediaDeviceProvider>
        <script
          src="https://cdn.usefathom.com/script.js"
          data-site="EWKEUHSN"
          defer
        ></script>
      </body>
    </html>
  );
}
