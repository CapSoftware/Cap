"use client";

import { type RefObject, useEffect } from "react";

const CONTEXT = "player.js";
const VERSION = "0.0.11";
const EVENTS = [
	"ready",
	"play",
	"pause",
	"ended",
	"timeupdate",
	"progress",
	"error",
	"seeked",
] as const;
const METHODS = [
	"play",
	"pause",
	"getPaused",
	"mute",
	"unmute",
	"getMuted",
	"setVolume",
	"getVolume",
	"getDuration",
	"setCurrentTime",
	"getCurrentTime",
	"setLoop",
	"getLoop",
	"removeEventListener",
	"addEventListener",
] as const;

type PlayerJsMessage = {
	context?: unknown;
	method?: unknown;
	value?: unknown;
	listener?: unknown;
};

type PlayerJsWindow = Pick<
	Window,
	"addEventListener" | "removeEventListener" | "location" | "parent"
> & {
	document: Pick<Document, "referrer">;
};

const parseMessage = (value: unknown): PlayerJsMessage | null => {
	if (typeof value === "string") {
		try {
			const parsed: unknown = JSON.parse(value);
			return parsed && typeof parsed === "object"
				? (parsed as PlayerJsMessage)
				: null;
		} catch {
			return null;
		}
	}
	return value && typeof value === "object" ? (value as PlayerJsMessage) : null;
};

const getProgress = (video: HTMLVideoElement) => {
	if (!Number.isFinite(video.duration) || video.duration <= 0) return 0;
	let buffered = 0;
	for (let index = 0; index < video.buffered.length; index++) {
		buffered = Math.max(buffered, video.buffered.end(index));
	}
	return Math.min(1, buffered / video.duration);
};

export const createPlayerJsReceiver = ({
	playerWindow,
	video,
}: {
	playerWindow: PlayerJsWindow;
	video: HTMLVideoElement;
}) => {
	const referrerOrigin = (() => {
		try {
			return playerWindow.document.referrer
				? new URL(playerWindow.document.referrer).origin
				: null;
		} catch {
			return null;
		}
	})();
	const listeners = new Map<string, Set<string | null>>();
	const send = (event: string, value?: unknown, listener?: string | null) => {
		const payload: Record<string, unknown> = {
			context: CONTEXT,
			version: VERSION,
			event,
		};
		if (value !== undefined) payload.value = value;
		if (listener !== undefined && listener !== null) {
			payload.listener = listener;
		}
		playerWindow.parent.postMessage(
			JSON.stringify(payload),
			referrerOrigin ?? "*",
		);
	};
	const emit = (event: string, value?: unknown) => {
		for (const listener of listeners.get(event) ?? []) {
			send(event, value, listener);
		}
	};
	const readyValue = () => ({
		src: playerWindow.location.toString(),
		events: [...EVENTS],
		methods: [...METHODS],
	});

	const onMessage = (event: MessageEvent) => {
		if (
			event.source !== playerWindow.parent ||
			(referrerOrigin !== null && event.origin !== referrerOrigin)
		) {
			return;
		}
		const message = parseMessage(event.data);
		if (
			message?.context !== CONTEXT ||
			typeof message.method !== "string" ||
			!METHODS.includes(message.method as (typeof METHODS)[number])
		) {
			return;
		}
		const listener =
			typeof message.listener === "string" ? message.listener : null;

		if (message.method === "addEventListener") {
			if (typeof message.value !== "string") return;
			const eventListeners = listeners.get(message.value) ?? new Set();
			eventListeners.add(listener);
			listeners.set(message.value, eventListeners);
			if (message.value === "ready") {
				send("ready", readyValue(), listener);
			}
			return;
		}
		if (message.method === "removeEventListener") {
			if (typeof message.value !== "string") return;
			const eventListeners = listeners.get(message.value);
			if (!eventListeners) return;
			eventListeners.delete(listener);
			if (eventListeners.size === 0) listeners.delete(message.value);
			return;
		}

		switch (message.method) {
			case "play":
				void video.play().catch(() => {
					emit("error", {
						code: video.error?.code ?? 0,
						msg: video.error?.message ?? "Playback was blocked",
					});
				});
				break;
			case "pause":
				video.pause();
				break;
			case "getPaused":
				send("getPaused", video.paused, listener);
				break;
			case "mute":
				video.muted = true;
				break;
			case "unmute":
				video.muted = false;
				break;
			case "getMuted":
				send("getMuted", video.muted, listener);
				break;
			case "setVolume":
				if (
					typeof message.value === "number" &&
					Number.isFinite(message.value)
				) {
					video.volume = Math.max(0, Math.min(1, message.value / 100));
				}
				break;
			case "getVolume":
				send("getVolume", video.volume * 100, listener);
				break;
			case "getDuration":
				send("getDuration", video.duration, listener);
				break;
			case "setCurrentTime":
				if (
					typeof message.value === "number" &&
					Number.isFinite(message.value)
				) {
					const duration = Number.isFinite(video.duration)
						? video.duration
						: message.value;
					video.currentTime = Math.max(0, Math.min(duration, message.value));
				}
				break;
			case "getCurrentTime":
				send("getCurrentTime", video.currentTime, listener);
				break;
			case "setLoop":
				if (typeof message.value === "boolean") {
					video.loop = message.value;
				}
				break;
			case "getLoop":
				send("getLoop", video.loop, listener);
				break;
		}
	};

	const eventHandlers = {
		play: () => emit("play"),
		pause: () => emit("pause"),
		ended: () => emit("ended"),
		timeupdate: () =>
			emit("timeupdate", {
				seconds: video.currentTime,
				duration: video.duration,
			}),
		progress: () => emit("progress", { percent: getProgress(video) }),
		error: () =>
			emit("error", {
				code: video.error?.code ?? 0,
				msg: video.error?.message ?? "Playback failed",
			}),
		seeked: () => emit("seeked"),
	};

	playerWindow.addEventListener("message", onMessage);
	for (const [event, handler] of Object.entries(eventHandlers)) {
		video.addEventListener(event, handler);
	}
	send("ready", readyValue());

	return () => {
		playerWindow.removeEventListener("message", onMessage);
		for (const [event, handler] of Object.entries(eventHandlers)) {
			video.removeEventListener(event, handler);
		}
		listeners.clear();
	};
};

export const usePlayerJsReceiver = ({
	playerContainerRef,
	videoRef,
}: {
	playerContainerRef: RefObject<HTMLDivElement | null>;
	videoRef: RefObject<HTMLVideoElement | null>;
}) => {
	useEffect(() => {
		const playerContainer = playerContainerRef.current;
		if (!playerContainer) return;
		let currentVideo: HTMLVideoElement | null = null;
		let dispose: (() => void) | null = null;
		const bind = () => {
			if (videoRef.current === currentVideo) return;
			dispose?.();
			currentVideo = videoRef.current;
			dispose = currentVideo
				? createPlayerJsReceiver({
						playerWindow: window,
						video: currentVideo,
					})
				: null;
		};
		const observer = new MutationObserver(bind);
		observer.observe(playerContainer, { childList: true, subtree: true });
		bind();

		return () => {
			observer.disconnect();
			dispose?.();
		};
	}, [playerContainerRef, videoRef]);
};
