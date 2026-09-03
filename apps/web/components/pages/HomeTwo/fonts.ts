import {
	DM_Mono,
	Geist,
	Instrument_Sans,
	Source_Serif_4,
} from "next/font/google";

export const htSans = Instrument_Sans({
	subsets: ["latin"],
	weight: ["400", "500"],
	display: "swap",
	variable: "--font-ht-sans",
});

export const htSerif = Source_Serif_4({
	subsets: ["latin"],
	weight: ["300", "400"],
	style: ["normal"],
	display: "swap",
	variable: "--font-ht-serif",
});

export const htGeist = Geist({
	subsets: ["latin"],
	weight: ["400", "500", "600"],
	display: "swap",
	variable: "--font-ht-geist",
});

export const htMono = DM_Mono({
	subsets: ["latin"],
	weight: ["400"],
	display: "swap",
	variable: "--font-ht-mono",
});
