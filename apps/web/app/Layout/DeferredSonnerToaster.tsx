"use client";

import { type ComponentType, useEffect, useState } from "react";

type IdleWindow = Window & {
	requestIdleCallback?: (
		callback: IdleRequestCallback,
		options?: IdleRequestOptions,
	) => number;
	cancelIdleCallback?: (handle: number) => void;
};

export function DeferredSonnerToaster() {
	const [Toaster, setToaster] = useState<ComponentType | null>(null);

	useEffect(() => {
		const loadToaster = () => {
			void import("@/components/SonnerToastProvider").then((module) => {
				setToaster(() => module.SonnerToaster);
			});
		};

		const idleWindow = window as IdleWindow;
		if (idleWindow.requestIdleCallback) {
			const handle = idleWindow.requestIdleCallback(loadToaster, {
				timeout: 3000,
			});
			return () => idleWindow.cancelIdleCallback?.(handle);
		}

		const timeout = window.setTimeout(loadToaster, 1500);
		return () => window.clearTimeout(timeout);
	}, []);

	return Toaster ? <Toaster /> : null;
}
