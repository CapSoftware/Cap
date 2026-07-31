"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import {
	captureProductPageEngagement,
	captureProductPageView,
	flushBrowserProductAnalytics,
	shouldCaptureProductPageView,
	touchProductAnalyticsSession,
} from "../utils/product-analytics";

let lastCapturedLocation: string | undefined;

export function ProductAnalyticsPageView() {
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const location = `${pathname}?${searchParams.toString()}`;

	useEffect(() => {
		if (
			!pathname ||
			location === lastCapturedLocation ||
			!shouldCaptureProductPageView(pathname)
		) {
			return;
		}
		lastCapturedLocation = location;
		const initialPageView = captureProductPageView();
		if (!initialPageView) return;
		let pageView = initialPageView;
		let activeSince =
			document.visibilityState === "visible" ? performance.now() : undefined;
		let pendingEngagedMs = 0;
		let maxScrollDepth = 0;
		const updateScrollDepth = () => {
			const scrollable =
				document.documentElement.scrollHeight - window.innerHeight;
			const depth = scrollable <= 0 ? 100 : (window.scrollY / scrollable) * 100;
			maxScrollDepth = Math.max(maxScrollDepth, Math.min(100, depth));
		};
		const flushEngagement = (mode: "normal" | "unload") => {
			if (activeSince !== undefined) {
				pendingEngagedMs += performance.now() - activeSince;
				activeSince = undefined;
			}
			if (pendingEngagedMs > 0 || maxScrollDepth > 0) {
				captureProductPageEngagement(
					pageView.eventId,
					pageView.sessionId,
					pathname,
					pendingEngagedMs,
					maxScrollDepth,
				);
				pendingEngagedMs = 0;
				maxScrollDepth = 0;
			}
			if (mode === "unload") void flushBrowserProductAnalytics("unload");
		};
		const updateVisibility = () => {
			if (document.visibilityState === "visible") {
				const context = touchProductAnalyticsSession();
				if (context.isSessionEntry) {
					const nextPageView = captureProductPageView(context);
					if (nextPageView) pageView = nextPageView;
				}
				activeSince = performance.now();
			} else {
				flushEngagement("unload");
			}
		};
		const pageHide = () => flushEngagement("unload");
		const heartbeat = window.setInterval(() => {
			if (document.visibilityState === "visible") {
				touchProductAnalyticsSession();
			}
		}, 60_000);
		window.addEventListener("scroll", updateScrollDepth, { passive: true });
		window.addEventListener("pagehide", pageHide, { passive: true });
		document.addEventListener("visibilitychange", updateVisibility);
		updateScrollDepth();

		return () => {
			window.clearInterval(heartbeat);
			window.removeEventListener("scroll", updateScrollDepth);
			window.removeEventListener("pagehide", pageHide);
			document.removeEventListener("visibilitychange", updateVisibility);
			flushEngagement("normal");
		};
	}, [location, pathname]);

	return null;
}
