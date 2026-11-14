"use client";

import { useEffect } from "react";
import { MESSAGE_TYPE } from "@/components/cap-player/messages";

export type EmbedErrorCode = "unavailable" | "paused";

const EMBED_PATH = /^\/dev\/[^/]+\/embed\/?$/;

const postEmbedError = (code: EmbedErrorCode) => {
	if (window.parent === window) return;
	window.parent.postMessage(
		{
			type: MESSAGE_TYPE,
			event: "error",
			currentTime: 0,
			duration: 0,
			paused: true,
			muted: false,
			code,
		},
		"*",
	);
};

// An embed with nothing to play still answers the page around it, so a
// player's events API reports the state instead of staying silent.
export function EmbedError({ code }: { code: EmbedErrorCode }) {
	useEffect(() => postEmbedError(code), [code]);
	return null;
}

// The not found page serves the share link and the embed alike, so only an
// embed's address reports a deleted or unknown video to its page.
export function EmbedNotFound() {
	useEffect(() => {
		if (EMBED_PATH.test(window.location.pathname)) {
			postEmbedError("unavailable");
		}
	}, []);
	return null;
}
