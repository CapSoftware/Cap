import {
	DM_Mono,
	Geist,
	Instrument_Sans,
	Source_Serif_4,
} from "next/font/google";

/**
 * The /home-two type system mirrors Intercom's three-role setup:
 * a regular-weight grotesk for display and UI, a light serif for body copy,
 * and an uppercase mono for eyebrows. All loaded only on this page via the
 * variable classes on the page's <main>.
 */

/** Display + UI grotesk (Saans analog). Applied as the page's base font. */
export const htSans = Instrument_Sans({
	subsets: ["latin"],
	weight: ["400", "500"],
	display: "swap",
	variable: "--font-ht-sans",
});

/** Light serif for body copy and quotes (Serrif analog). */
export const htSerif = Source_Serif_4({
	subsets: ["latin"],
	weight: ["300", "400"],
	style: ["normal"],
	display: "swap",
	variable: "--font-ht-serif",
});

/**
 * The Cap desktop app's actual UI font (Geist Sans at weight 500), used only
 * inside the "See how it works" desktop demo so the recreated app windows
 * render with the same type as the real app.
 */
export const htGeist = Geist({
	subsets: ["latin"],
	weight: ["400", "500", "600"],
	display: "swap",
	variable: "--font-ht-geist",
});

/** Uppercase mono for eyebrows and small labels (SaansMono analog). */
export const htMono = DM_Mono({
	subsets: ["latin"],
	weight: ["400"],
	display: "swap",
	variable: "--font-ht-mono",
});
