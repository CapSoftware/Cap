"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

type IdleWindow = Window & {
	requestIdleCallback?: (
		callback: IdleRequestCallback,
		options?: IdleRequestOptions,
	) => number;
	cancelIdleCallback?: (handle: number) => void;
};

interface WhenVisibleProps {
	children: ReactNode;
	fallback?: ReactNode;
	rootMargin?: string;
	className?: string;
}

// Renders `fallback` until the wrapper scrolls within `rootMargin` of the
// viewport, then mounts `children`. Used to keep heavy client-only widgets
// (e.g. Rive canvases) out of the initial render while the surrounding section
// is still server-rendered.
export function WhenVisible({
	children,
	fallback = null,
	rootMargin = "200px",
	className,
}: WhenVisibleProps) {
	const ref = useRef<HTMLDivElement>(null);
	const [show, setShow] = useState(false);

	useEffect(() => {
		if (show) return;

		const load = () => setShow(true);
		const idleWindow = window as IdleWindow;
		const scheduleLoad = () => {
			if (idleWindow.requestIdleCallback) {
				const handle = idleWindow.requestIdleCallback(load, { timeout: 1200 });
				return () => idleWindow.cancelIdleCallback?.(handle);
			}

			const timeout = window.setTimeout(load, 120);
			return () => window.clearTimeout(timeout);
		};

		const element = ref.current;
		if (!element || !("IntersectionObserver" in window)) {
			return scheduleLoad();
		}

		let cancelIdleLoad: (() => void) | undefined;
		const observer = new IntersectionObserver(
			([entry]) => {
				if (!entry?.isIntersecting) return;
				observer.disconnect();
				cancelIdleLoad = scheduleLoad();
			},
			{ rootMargin },
		);

		observer.observe(element);

		return () => {
			observer.disconnect();
			cancelIdleLoad?.();
		};
	}, [rootMargin, show]);

	return (
		<div ref={ref} className={className}>
			{show ? children : fallback}
		</div>
	);
}
