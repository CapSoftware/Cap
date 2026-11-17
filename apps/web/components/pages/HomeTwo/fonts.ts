import {
	DM_Mono,
	Geist,
	Instrument_Sans,
	Source_Serif_4,
} from "next/font/google";

export const htSans = Instrument_Sans({
	subsets: ["latin"],
	display: "swap",
	variable: "--font-ht-sans",
});

export const htSerif = Source_Serif_4({
	subsets: ["latin"],
	weight: ["300", "400"],
	style: ["normal", "italic"],
	display: "swap",
	variable: "--font-ht-serif",
});

// Geist and DM Mono only appear inside the animated stages below the fold, so
// they are fetched when first used instead of competing with the hero fonts.
export const htGeist = Geist({
	subsets: ["latin"],
	weight: ["400", "500", "600"],
	display: "swap",
	preload: false,
	variable: "--font-ht-geist",
});

export const htMono = DM_Mono({
	subsets: ["latin"],
	weight: ["400"],
	display: "swap",
	preload: false,
	variable: "--font-ht-mono",
});
