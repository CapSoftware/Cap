"use client";

import { boundedForegroundEngagementMs } from "@cap/analytics";
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
const SESSION_TOUCH_THROTTLE_MS = 5_000;

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
		const initialActivityAt = performance.now();
		let activeSince =
			document.visibilityState === "visible" ? initialActivityAt : undefined;
		let lastInteractionAt = initialActivityAt;
		let lastSessionTouchAt = initialActivityAt;
		let pendingEngagedMs = 0;
		let maxScrollDepth = 0;
		const accrueEngagement = (now: number) => {
			if (activeSince === undefined) return;
			pendingEngagedMs += boundedForegroundEngagementMs({
				activeSince,
				lastInteractionAt,
				now,
			});
			activeSince = undefined;
		};
		const flushEngagement = (mode: "normal" | "unload") => {
			accrueEngagement(performance.now());
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
		const recordActivity = (forceSessionTouch = false) => {
			if (document.visibilityState !== "visible") return;
			const now = performance.now();
			accrueEngagement(now);
			lastInteractionAt = now;
			activeSince = now;
			if (
				!forceSessionTouch &&
				now - lastSessionTouchAt < SESSION_TOUCH_THROTTLE_MS
			) {
				return;
			}
			lastSessionTouchAt = now;
			const context = touchProductAnalyticsSession();
			if (!context.isSessionEntry) return;
			flushEngagement("normal");
			const nextPageView = captureProductPageView(context);
			if (nextPageView) pageView = nextPageView;
			lastInteractionAt = now;
			activeSince = now;
		};
		const updateScrollDepth = () => {
			const scrollable =
				document.documentElement.scrollHeight - window.innerHeight;
			const depth = scrollable <= 0 ? 100 : (window.scrollY / scrollable) * 100;
			maxScrollDepth = Math.max(maxScrollDepth, Math.min(100, depth));
			recordActivity();
		};
		const handleActivity = () => recordActivity();
		const updateVisibility = () => {
			if (document.visibilityState === "visible") {
				recordActivity(true);
			} else {
				flushEngagement("unload");
			}
		};
		const pageHide = () => flushEngagement("unload");
		window.addEventListener("scroll", updateScrollDepth, { passive: true });
		window.addEventListener("pointerdown", handleActivity, { passive: true });
		window.addEventListener("touchstart", handleActivity, { passive: true });
		window.addEventListener("keydown", handleActivity);
		window.addEventListener("pagehide", pageHide, { passive: true });
		document.addEventListener("visibilitychange", updateVisibility);
		updateScrollDepth();

		return () => {
			window.removeEventListener("scroll", updateScrollDepth);
			window.removeEventListener("pointerdown", handleActivity);
			window.removeEventListener("touchstart", handleActivity);
			window.removeEventListener("keydown", handleActivity);
			window.removeEventListener("pagehide", pageHide);
			document.removeEventListener("visibilitychange", updateVisibility);
			flushEngagement("normal");
		};
	}, [location, pathname]);

	return null;
}
