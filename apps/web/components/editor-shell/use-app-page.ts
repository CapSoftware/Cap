"use client";

import { useEffect } from "react";

export function useAppPage(enabled = true) {
	useEffect(() => {
		if (!enabled) return;
		const root = document.documentElement;
		const previous = root.style.overscrollBehavior;
		root.style.overscrollBehavior = "none";
		const preventZoom = (event: WheelEvent) => {
			if (event.ctrlKey) event.preventDefault();
		};
		window.addEventListener("wheel", preventZoom, { passive: false });
		return () => {
			root.style.overscrollBehavior = previous;
			window.removeEventListener("wheel", preventZoom);
		};
	}, [enabled]);
}
