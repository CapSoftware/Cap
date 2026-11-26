"use client";

import { useEffect, useState } from "react";
import { ENDS_AT } from "./content";

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

const remaining = (ms: number) => {
	const minutes = Math.ceil(ms / 60_000);
	if (minutes < 60) return plural(minutes, "minute");
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return plural(hours, "hour");
	return plural(Math.floor(hours / 24), "day");
};

// Rendered only after mount so the server and first client render match.
export function Countdown() {
	const [now, setNow] = useState<number | null>(null);

	useEffect(() => {
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 30_000);
		return () => window.clearInterval(timer);
	}, []);

	if (now === null) return <span>Ends Cyber Monday</span>;
	const left = ENDS_AT - now;
	if (left <= 0) return <span>The offer has ended</span>;
	return <span className="tabular-nums">Ends in {remaining(left)}</span>;
}
