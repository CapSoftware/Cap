"use client";

import { useEffect } from "react";

/**
 * The editor pages behave like an app: pinch or ctrl+scroll never zooms the
 * page and sideways scrolling never swipes back through history.
 */
export function useAppPage() {
	useEffect(() => {
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
	}, []);
}
