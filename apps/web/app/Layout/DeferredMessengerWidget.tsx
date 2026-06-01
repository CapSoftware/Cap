"use client";

import { type ComponentType, useEffect, useState } from "react";

type IdleWindow = Window & {
	requestIdleCallback?: (
		callback: IdleRequestCallback,
		options?: IdleRequestOptions,
	) => number;
	cancelIdleCallback?: (handle: number) => void;
};

export function DeferredMessengerWidget() {
	const [Widget, setWidget] = useState<ComponentType | null>(null);

	useEffect(() => {
		const loadWidget = () => {
			void import("./MessengerWidget").then((module) => {
				setWidget(() => module.MessengerWidget);
			});
		};

		const idleWindow = window as IdleWindow;
		if (idleWindow.requestIdleCallback) {
			const handle = idleWindow.requestIdleCallback(loadWidget, {
				timeout: 4000,
			});
			return () => idleWindow.cancelIdleCallback?.(handle);
		}

		const timeout = window.setTimeout(loadWidget, 2500);
		return () => window.clearTimeout(timeout);
	}, []);

	return Widget ? <Widget /> : null;
}
