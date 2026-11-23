"use client";

import {
	createContext,
	type PropsWithChildren,
	useCallback,
	useContext,
	useSyncExternalStore,
} from "react";

const TICK_MS = 60_000;

const ServerNowContext = createContext<number | null>(null);

export function ShareNowProvider({
	now,
	children,
}: PropsWithChildren<{ now: number }>) {
	return (
		<ServerNowContext.Provider value={now}>
			{children}
		</ServerNowContext.Provider>
	);
}

let clientNow = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

const tick = () => {
	clientNow = Date.now();
	for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	if (timer === null) {
		clientNow = Date.now();
		timer = setInterval(tick, TICK_MS);
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0 && timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	};
};

const getClientNow = () => clientNow;

// Hydration renders with the server's render time (or null without a
// provider), so server HTML and the first client render match even when the
// viewer's clock is off or a minute boundary falls between them. React then
// re-renders with the viewer's clock once subscribed.
export function useNow(): number | null {
	const serverNow = useContext(ServerNowContext);
	const getServerNow = useCallback(() => serverNow, [serverNow]);
	return useSyncExternalStore<number | null>(
		subscribe,
		getClientNow,
		getServerNow,
	);
}

const utcDate = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});

export function RelativeTime({
	date,
	format,
}: {
	date: Date;
	format: (date: Date, now: Date) => string;
}) {
	const now = useNow();
	const valid = !Number.isNaN(date.getTime());
	let text = "";
	if (valid)
		text = now === null ? utcDate.format(date) : format(date, new Date(now));
	return <time dateTime={valid ? date.toISOString() : undefined}>{text}</time>;
}
