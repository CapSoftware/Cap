"use client";

import { useEffect } from "react";
import { MESSAGE_TYPE } from "@/components/cap-player/messages";

export type EmbedErrorCode = "unavailable" | "paused";

// An embed with nothing to play still answers the page around it, so a
// player's events API reports the state instead of staying silent.
export function EmbedError({ code }: { code: EmbedErrorCode }) {
	useEffect(() => {
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
	}, [code]);
	return null;
}
