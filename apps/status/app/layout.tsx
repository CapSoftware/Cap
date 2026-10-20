import type { Metadata } from "next";
import { DM_Mono, Instrument_Sans, Source_Serif_4 } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const sans = Instrument_Sans({
	subsets: ["latin"],
	weight: ["400", "500", "600"],
	variable: "--font-sans",
	display: "swap",
});
const serif = Source_Serif_4({
	subsets: ["latin"],
	weight: ["300", "400"],
	variable: "--font-serif",
	display: "swap",
});
const mono = DM_Mono({
	subsets: ["latin"],
	weight: "400",
	variable: "--font-mono",
	display: "swap",
});

export const metadata: Metadata = {
	metadataBase: new URL("https://status.cap.so"),
	title: "Cap Status — A little peace of mind.",
	description: "Live service health, uptime, and incident history for Cap.",
	icons: { icon: "/cap-icon.svg" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html
			lang="en"
			className={`${sans.variable} ${serif.variable} ${mono.variable}`}
		>
			<body>{children}</body>
		</html>
	);
}
