"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { infraRefreshDelayMs } from "@/lib/infra-video-view";

export function useLiveRefresh(active: boolean) {
	const router = useRouter();

	useEffect(() => {
		if (!active) return;
		const started = Date.now();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const schedule = () => {
			const delay = infraRefreshDelayMs(Date.now() - started);
			if (delay === null) return;
			timer = setTimeout(() => {
				if (document.visibilityState === "visible") router.refresh();
				schedule();
			}, delay);
		};
		const onVisible = () => {
			if (document.visibilityState === "visible") router.refresh();
		};
		schedule();
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [active, router]);
}
