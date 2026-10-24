import { useEffect, useState } from "react";

/**
 * Detects whether the current browser is Chromium-based (Chrome, Edge, Brave,
 * Arc, Opera, Vivaldi, …), i.e. one that can install the Cap Chrome extension.
 *
 * Defaults to `true` during SSR and on the first client render — Chromium is
 * the overwhelming majority, so this avoids a layout flash for most visitors
 * while still resolving the real value after mount (non-Chromium browsers see a
 * single reflow). Detection runs in an effect, so there's no hydration mismatch.
 */
export const useIsChromium = (): boolean => {
	const [isChromium, setIsChromium] = useState(true);

	useEffect(() => {
		if (typeof navigator === "undefined") return;

		const uaData = (navigator as any).userAgentData;
		if (Array.isArray(uaData?.brands)) {
			setIsChromium(
				uaData.brands.some((b: { brand: string }) => /chromium/i.test(b.brand)),
			);
			return;
		}

		// Fallback for browsers without userAgentData: every Chromium-based
		// engine reports "Chrome" in its UA, while Safari and Firefox do not.
		// Exclude CriOS (Chrome on iOS) since extensions aren't supported there.
		const ua = navigator.userAgent;
		setIsChromium(/chrome|chromium/i.test(ua) && !/crios/i.test(ua));
	}, []);

	return isChromium;
};
