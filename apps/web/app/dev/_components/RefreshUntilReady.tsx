"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const QUICK_CHECKS = 20;
const STEADY_CHECKS = 80;
const QUICK_INTERVAL_MS = 3_000;
const STEADY_INTERVAL_MS = 10_000;
const IDLE_INTERVAL_MS = 60_000;

const intervalAfter = (checks: number) => {
	if (checks < QUICK_CHECKS) return QUICK_INTERVAL_MS;
	return checks < STEADY_CHECKS ? STEADY_INTERVAL_MS : IDLE_INTERVAL_MS;
};

export function RefreshUntilReady() {
	const router = useRouter();

	useEffect(() => {
		let timer = 0;
		let checks = 0;

		const schedule = () => {
			timer = window.setTimeout(check, intervalAfter(checks));
		};
		const check = () => {
			if (document.visibilityState === "visible") {
				checks++;
				router.refresh();
			}
			schedule();
		};
		const onVisibility = () => {
			if (document.visibilityState !== "visible") return;
			window.clearTimeout(timer);
			check();
		};

		schedule();
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			window.clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [router]);

	return null;
}
