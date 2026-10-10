"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const PREWARM_TIMEOUT_MS = 60_000;
let prewarmed = false;

/**
 * Loads the editor once in a hidden frame so its code and renderer are in the
 * browser cache (and the renderer compiled) before the editor is opened. The
 * frame is removed as soon as it reports back. `route` is the page that will
 * host the editor, prefetched at the same time.
 */
export function EditorPrewarm({
	enabled = true,
	route,
}: {
	enabled?: boolean;
	route?: string;
}) {
	const router = useRouter();
	const [active, setActive] = useState(false);

	useEffect(() => {
		if (!enabled || (prewarmed && !route)) return;
		const connection = (
			navigator as Navigator & { connection?: { saveData?: boolean } }
		).connection;
		if (connection?.saveData) return;
		const start = () => {
			if (route) router.prefetch(route);
			if (prewarmed) return;
			prewarmed = true;
			setActive(true);
		};
		if (typeof window.requestIdleCallback === "function") {
			const handle = window.requestIdleCallback(start, { timeout: 2000 });
			return () => window.cancelIdleCallback(handle);
		}
		const handle = setTimeout(start, 500);
		return () => clearTimeout(handle);
	}, [enabled, route, router]);

	useEffect(() => {
		if (!active) return;
		const onMessage = (event: MessageEvent<unknown>) => {
			if (event.origin !== window.location.origin) return;
			const data = event.data as { kind?: unknown } | null;
			if (data?.kind === "cap-editor-prewarmed") setActive(false);
		};
		window.addEventListener("message", onMessage);
		const timeout = setTimeout(() => setActive(false), PREWARM_TIMEOUT_MS);
		return () => {
			window.removeEventListener("message", onMessage);
			clearTimeout(timeout);
		};
	}, [active]);

	if (!active) return null;
	return (
		<iframe
			src="/editor-solid/index.html?prewarm=1"
			title="Editor preload"
			aria-hidden="true"
			tabIndex={-1}
			className="pointer-events-none fixed left-0 top-0 h-px w-px opacity-0"
		/>
	);
}
