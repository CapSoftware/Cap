import "@/app/globals.css";
import type { Metadata } from "next";
import localFont from "next/font/local";
import Script from "next/script";
import type { PropsWithChildren } from "react";

const defaultFont = localFont({
	src: [
		{
			path: "../public/fonts/NeueMontreal-Bold.woff2",
			weight: "700",
			style: "normal",
		},
		{
			path: "../public/fonts/NeueMontreal-Regular.woff2",
			weight: "400",
			style: "normal",
		},
		{
			path: "../public/fonts/NeueMontreal-Medium.woff2",
			weight: "500",
			style: "normal",
		},
		{
			path: "../public/fonts/NeueMontreal-MediumItalic.woff2",
			weight: "500",
			style: "italic",
		},
		{
			path: "../public/fonts/NeueMontreal-Italic.woff2",
			weight: "400",
			style: "italic",
		},
		{
			path: "../public/fonts/NeueMontreal-BoldItalic.woff2",
			weight: "700",
			style: "italic",
		},
	],
	preload: false,
});

export const metadata: Metadata = {
	metadataBase: new URL("https://cap.so"),
	title: "Cap — 精美的屏幕录制，完全由你掌控。",
	description:
		"Cap 是 Loom 的开源替代方案，轻量、强大且支持跨平台。只需几秒即可录制和分享。",
	openGraph: {
		title: "Cap — 精美的屏幕录制，完全由你掌控。",
		description:
			"Cap 是 Loom 的开源替代方案，轻量、强大且支持跨平台。只需几秒即可录制和分享。",
		type: "website",
		url: "https://cap.so",
		images: ["https://cap.so/og.png"],
	},
};

export default function RootLayout({ children }: PropsWithChildren) {
	return (
		<html className={defaultFont.className} lang="zh-CN">
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
				<Script src="/theme-script.js" strategy="beforeInteractive" />
				<main className="w-full">{children}</main>
			</body>
		</html>
	);
}
