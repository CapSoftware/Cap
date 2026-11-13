import { Geist, Geist_Mono } from "next/font/google";

export const infraSans = Geist({
	subsets: ["latin"],
	weight: ["400", "500"],
	display: "swap",
	variable: "--font-infra-sans",
});

export const infraMono = Geist_Mono({
	subsets: ["latin"],
	weight: ["400"],
	display: "swap",
	preload: false,
	variable: "--font-infra-mono",
});
