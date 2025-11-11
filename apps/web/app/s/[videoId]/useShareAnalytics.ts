"use client";

import type * as WebDomain from "@cap/web-domain";
import type { Schema } from "effect/Schema";
import { useCallback, useEffect, useRef } from "react";
import type { ShareAnalyticsContext } from "./types";

type CapturePayload = Schema.Type<
	typeof WebDomain.VideoAnalytics.VideoCaptureEvent
>;


type ClientAnalyticsExtras = {
	locale?: string;
	language?: string;
	timezone?: string;
	pathname?: string;
	href?: string;
	referrer?: string;
	userAgent?: string;
};

type Options = {
	videoId: WebDomain.Video.VideoId;
	analyticsContext: ShareAnalyticsContext;
	videoElement: HTMLVideoElement | null;
	enabled: boolean;
};

const ANALYTICS_ENDPOINT = "/api/video/analytics";
const SESSION_STORAGE_KEY = "cap.analytics.session";
const SESSION_TTL_MS = 30 * 60 * 1000;

const randomId = () =>
	typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
		? crypto.randomUUID()
		: Math.random().toString(36).slice(2);

export function useShareAnalytics({
	videoId,
	analyticsContext,
	videoElement,
	enabled,
}: Options) {
	const analyticsRef = useRef(analyticsContext);
	const videoIdRef = useRef(videoId);
	const fallbackSessionRef = useRef<string | null>(null);
	const sessionIdRef = useRef<string | null>(null);
	const clientDataRef = useRef<ClientAnalyticsExtras | null>(null);
	const sentRef = useRef(false);
	const watchStartRef = useRef<number | null>(null);
	const watchedMsRef = useRef(0);

	analyticsRef.current = analyticsContext;
	videoIdRef.current = videoId;

	const accumulateWatchTime = useCallback(() => {
		if (watchStartRef.current === null) return;
		watchedMsRef.current += performance.now() - watchStartRef.current;
		watchStartRef.current = null;
	}, []);

	const ensureSessionId = useCallback(() => {
		if (typeof window === "undefined") {
			if (!fallbackSessionRef.current)
				fallbackSessionRef.current = randomId();
			return fallbackSessionRef.current;
		}

		try {
			const storedValue = window.localStorage.getItem(SESSION_STORAGE_KEY);
			const now = Date.now();
			if (storedValue) {
				const parsed = JSON.parse(storedValue) as { value?: string; expiry?: number };
				if (
					parsed?.value &&
					typeof parsed.value === "string" &&
					typeof parsed.expiry === "number" &&
					parsed.expiry > now
				) {
					const refreshed = JSON.stringify({
						value: parsed.value,
						expiry: now + SESSION_TTL_MS,
					});
					window.localStorage.setItem(SESSION_STORAGE_KEY, refreshed);
					return parsed.value;
				}
			}

			const nextSessionId =
				window.crypto?.randomUUID?.() ?? randomId();
			const serialized = JSON.stringify({
				value: nextSessionId,
				expiry: now + SESSION_TTL_MS,
			});
			window.localStorage.setItem(SESSION_STORAGE_KEY, serialized);
			return nextSessionId;
		} catch {
			if (!fallbackSessionRef.current) fallbackSessionRef.current = randomId();
			return fallbackSessionRef.current;
		}
	}, []);

	const getClientAnalytics = useCallback((): ClientAnalyticsExtras => {
		if (clientDataRef.current) return clientDataRef.current;
		if (typeof window === "undefined") return {};

		const data: ClientAnalyticsExtras = {
			locale:
				(window.navigator.languages?.[0]) ||
				window.navigator.language,
			language: window.navigator.language,
			timezone: (() => {
				try {
					return Intl.DateTimeFormat().resolvedOptions().timeZone;
				} catch {
					return undefined;
				}
			})(),
			pathname: window.location.pathname,
			href: window.location.href,
			referrer: document.referrer || undefined,
			userAgent: window.navigator.userAgent,
		};

		clientDataRef.current = data;
		return data;
	}, []);

	const buildPayload = useCallback(
		(watchTimeSeconds: number): CapturePayload => {
		const analytics = analyticsRef.current;
		const client = getClientAnalytics();
		const normalizedWatch = Math.max(0, Math.trunc(watchTimeSeconds));
		const sessionId = sessionIdRef.current ?? ensureSessionId();
		const normalize = (value?: string | null) =>
			value && value.trim().length > 0 ? value : undefined;

		const city = normalize(analytics.city);
		const country = normalize(analytics.country);
		const device = normalize(analytics.device);
		const browser = normalize(analytics.browser);
		const os = normalize(analytics.os);

		const clientReferrer = normalize(client.referrer);
		const referrer = normalize(analytics.referrer) ?? clientReferrer;
		const referrerUrl = normalize(analytics.referrerUrl) ?? clientReferrer;
		const utmSource = normalize(analytics.utmSource);
		const utmMedium = normalize(analytics.utmMedium);
		const utmCampaign = normalize(analytics.utmCampaign);
		const utmTerm = normalize(analytics.utmTerm);
		const utmContent = normalize(analytics.utmContent);
		const userAgent = normalize(analytics.userAgent) ?? normalize(client.userAgent);
		const locale = normalize(client.locale);
		const language = normalize(client.language);
		const timezone = normalize(client.timezone);
		const pathname = normalize(client.pathname);
		const href = normalize(client.href);

		return {
			video: videoIdRef.current,
			watchTimeSeconds: normalizedWatch > 0 ? normalizedWatch : 0,
			...(sessionId ? { sessionId } : {}),
			...(city ? { city } : {}),
			...(country ? { country } : {}),
			...(device ? { device } : {}),
			...(browser ? { browser } : {}),
			...(os ? { os } : {}),
			...(referrer ? { referrer } : {}),
			...(referrerUrl ? { referrerUrl } : {}),
			...(utmSource ? { utmSource } : {}),
			...(utmMedium ? { utmMedium } : {}),
			...(utmCampaign ? { utmCampaign } : {}),
			...(utmTerm ? { utmTerm } : {}),
			...(utmContent ? { utmContent } : {}),
			...(userAgent ? { userAgent } : {}),
			...(locale ? { locale } : {}),
			...(language ? { language } : {}),
			...(timezone ? { timezone } : {}),
			...(pathname ? { pathname } : {}),
			...(href ? { href } : {}),
		} satisfies CapturePayload;
		},
		[getClientAnalytics, ensureSessionId],
	);

	const sendPayload = useCallback(
		(reason: string) => {
		if (!enabled || sentRef.current) return;

		accumulateWatchTime();
		const watchSeconds = watchedMsRef.current / 1000;
		const payload = buildPayload(watchSeconds);
		sentRef.current = true;
		const body = JSON.stringify(payload);

		const sendWithBeacon = () => {
			if (typeof navigator === "undefined" || !navigator.sendBeacon) return false;
			try {
				const blob = new Blob([body], { type: "application/json" });
				return navigator.sendBeacon(ANALYTICS_ENDPOINT, blob);
			} catch {
				return false;
			}
		};

		const fallbackFetch = () =>
			fetch(ANALYTICS_ENDPOINT, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
				keepalive: reason !== "manual",
			}).catch(() => undefined);

		if (!sendWithBeacon()) void fallbackFetch();
	}, [accumulateWatchTime, buildPayload, enabled]);

	useEffect(() => {
		if (!enabled) return;
		sessionIdRef.current = ensureSessionId();
	}, [enabled, ensureSessionId]);

	useEffect(() => {
		if (!enabled || !videoElement) return;

		const handlePlay = () => {
			if (document.hidden) return;
			if (watchStartRef.current === null) watchStartRef.current = performance.now();
		};
		const handlePauseLike = () => accumulateWatchTime();
		const handleVisibility = () => {
			if (document.visibilityState === "hidden") {
				accumulateWatchTime();
			} else if (!videoElement.paused) {
				handlePlay();
			}
		};

		videoElement.addEventListener("playing", handlePlay);
		videoElement.addEventListener("pause", handlePauseLike);
		videoElement.addEventListener("ended", handlePauseLike);
		videoElement.addEventListener("waiting", handlePauseLike);
		videoElement.addEventListener("seeking", handlePauseLike);
		document.addEventListener("visibilitychange", handleVisibility);

		if (!videoElement.paused && !document.hidden) handlePlay();

		return () => {
			accumulateWatchTime();
			videoElement.removeEventListener("playing", handlePlay);
			videoElement.removeEventListener("pause", handlePauseLike);
			videoElement.removeEventListener("ended", handlePauseLike);
			videoElement.removeEventListener("waiting", handlePauseLike);
			videoElement.removeEventListener("seeking", handlePauseLike);
			document.removeEventListener("visibilitychange", handleVisibility);
		};
	}, [accumulateWatchTime, enabled, videoElement]);

	useEffect(() => {
		if (!enabled) return;

		const handlePageHide = () => sendPayload("pagehide");

		window.addEventListener("pagehide", handlePageHide);
		window.addEventListener("beforeunload", handlePageHide);

		return () => {
			window.removeEventListener("pagehide", handlePageHide);
			window.removeEventListener("beforeunload", handlePageHide);
			sendPayload("manual");
		};
	}, [enabled, sendPayload]);
}
