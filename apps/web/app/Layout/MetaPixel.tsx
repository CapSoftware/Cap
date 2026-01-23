"use client";

import { buildEnv } from "@inflight/env";
import Script from "next/script";
import { useId, useRef } from "react";

declare global {
	interface Window {
		fbq: (command: string, ...args: unknown[]) => void;
		_fbq: unknown;
	}
}

export function MetaPixel() {
	const pixelInitialized = useRef(false);
	const pixelId = buildEnv.NEXT_PUBLIC_META_PIXEL_ID;
	const scriptId = useId();

	if (!pixelId) {
		return null;
	}

	if (typeof window !== "undefined" && !window.fbq) {
		const w = window as unknown as Record<string, any>;
		const n: any = (...args: unknown[]) => {
			if (n.callMethod) {
				n.callMethod.apply(n, args as any);
			} else {
				n.queue.push(args);
			}
		};
		if (!w._fbq) w._fbq = n;
		n.push = n;
		n.loaded = true;
		n.version = "2.0";
		n.queue = [] as unknown[];
		w.fbq = n as unknown;
	}

	return (
		<>
			<Script
				id={scriptId}
				strategy="afterInteractive"
				src="https://connect.facebook.net/en_US/fbevents.js"
				onLoad={() => {
					if (
						!pixelInitialized.current &&
						typeof window !== "undefined" &&
						window.fbq &&
						pixelId
					) {
						window.fbq("init", pixelId);
						window.fbq("track", "PageView");
						pixelInitialized.current = true;
					}
				}}
			/>
			<noscript>
				<img
					height="1"
					width="1"
					style={{ display: "none" }}
					src={`https://www.facebook.com/tr?id=${pixelId}&ev=PageView&noscript=1`}
					alt=""
				/>
			</noscript>
		</>
	);
}

export function trackMetaEvent(
	eventName: string,
	parameters?: Record<string, unknown>,
	options?: { eventId?: string },
) {
	if (typeof window !== "undefined" && window.fbq) {
		try {
			if (options?.eventId) {
				window.fbq("track", eventName, parameters, {
					eventID: options.eventId,
				});
			} else {
				window.fbq("track", eventName, parameters);
			}
		} catch (error) {
			console.error(`Error tracking Meta event ${eventName}:`, error);
		}
	}
}
