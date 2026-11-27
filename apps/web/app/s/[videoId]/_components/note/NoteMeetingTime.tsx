"use client";

import { useSyncExternalStore } from "react";

const utcDay = new Intl.DateTimeFormat("en-US", {
	weekday: "short",
	month: "short",
	day: "numeric",
	timeZone: "UTC",
});

const localDay = new Intl.DateTimeFormat("en-US", {
	weekday: "short",
	month: "short",
	day: "numeric",
});

const localTime = new Intl.DateTimeFormat("en-US", {
	hour: "numeric",
	minute: "2-digit",
});

const subscribeToNothing = () => () => {};

export function NoteMeetingTime({ iso }: { iso: string }) {
	const hydrated = useSyncExternalStore(
		subscribeToNothing,
		() => true,
		() => false,
	);
	const date = new Date(iso);
	return (
		<time dateTime={iso}>
			{hydrated
				? `${localDay.format(date)} · ${localTime.format(date)}`
				: utcDay.format(date)}
		</time>
	);
}
