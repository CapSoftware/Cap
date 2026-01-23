"use client";

import { buildEnv } from "@inflight/env";
import Script from "next/script";
import { useId, useRef } from "react";

declare global {
	interface Window {
		gtag: (command: string, ...args: unknown[]) => void;
		dataLayer: unknown[];
	}
}

export function GTag() {
	const gtagInitialized = useRef(false);
	const awId = buildEnv.NEXT_PUBLIC_GOOGLE_AW_ID;
	const scriptId = useId();

	if (!awId) {
		return null;
	}

	if (typeof window !== "undefined" && !window.dataLayer) {
		window.dataLayer = window.dataLayer || [];
		window.gtag = function gtag() {
			window.dataLayer.push(arguments);
		};
	}

	return (
		<Script
			id={scriptId}
			strategy="afterInteractive"
			src={`https://www.googletagmanager.com/gtag/js?id=${awId}`}
			onLoad={() => {
				if (
					!gtagInitialized.current &&
					typeof window !== "undefined" &&
					window.gtag &&
					awId
				) {
					window.gtag("js", new Date());
					window.gtag("config", awId);
					gtagInitialized.current = true;
				}
			}}
		/>
	);
}

export function trackGoogleEvent(
	action: string,
	parameters?: Record<string, unknown>,
) {
	if (typeof window !== "undefined" && window.gtag) {
		try {
			window.gtag("event", action, parameters);
		} catch (error) {
			console.error(`Error tracking Google event ${action}:`, error);
		}
	}
}
