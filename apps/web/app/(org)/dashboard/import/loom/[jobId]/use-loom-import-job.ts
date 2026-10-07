"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
	isLoomImportJobActive,
	type LoomImportItemView,
	type LoomImportSnapshot,
} from "@/lib/loom-import/status";

const ACTIVE_POLL_MS = 1500;
const HIDDEN_POLL_MS = 15_000;
const UPGRADE_POLL_MS = 2500;
const RATE_WINDOW_MS = 180_000;
const RATE_MIN_SPAN_MS = 20_000;

export type LoomImportSummary = Omit<
	LoomImportSnapshot,
	"items" | "cursor" | "full"
>;

type RateSample = { at: number; settled: number };

function toSummary(snapshot: LoomImportSnapshot): LoomImportSummary {
	return {
		job: snapshot.job,
		counts: snapshot.counts,
		totalDuration: snapshot.totalDuration,
		importedDuration: snapshot.importedDuration,
		owners: snapshot.owners,
	};
}

function settledCount(summary: LoomImportSummary) {
	const { imported, failed, skipped, cancelled } = summary.counts;
	return imported + failed + skipped + cancelled;
}

export function mergeLoomImportItems(
	map: Map<string, LoomImportItemView>,
	order: string[],
	snapshot: LoomImportSnapshot,
) {
	let nextOrder = order;
	if (snapshot.full) {
		map.clear();
		nextOrder = snapshot.items.map((item) => item.id);
	}
	let changed = snapshot.full;
	for (const item of snapshot.items) {
		const previous = map.get(item.id);
		if (
			!previous ||
			previous.v !== item.v ||
			previous.status !== item.status ||
			previous.progress !== item.progress ||
			previous.stage !== item.stage
		) {
			map.set(item.id, item);
			changed = true;
		}
	}
	return { order: nextOrder, changed };
}

export function useLoomImportJob(
	initial: LoomImportSnapshot,
	{ watchForUpgrade }: { watchForUpgrade: boolean },
) {
	const itemsRef = useRef<Map<string, LoomImportItemView> | null>(null);
	const orderRef = useRef<string[]>([]);
	const cursorRef = useRef(initial.cursor);
	const samplesRef = useRef<RateSample[]>([]);
	if (itemsRef.current === null) {
		itemsRef.current = new Map(initial.items.map((item) => [item.id, item]));
		orderRef.current = initial.items.map((item) => item.id);
	}

	const [items, setItems] = useState<LoomImportItemView[]>(initial.items);
	const [summary, setSummary] = useState<LoomImportSummary>(() =>
		toSummary(initial),
	);
	const [rate, setRate] = useState<number | null>(null);

	const apply = useCallback((snapshot: LoomImportSnapshot) => {
		const map = itemsRef.current;
		if (!map) return;
		const merged = mergeLoomImportItems(map, orderRef.current, snapshot);
		orderRef.current = merged.order;
		cursorRef.current = Math.max(cursorRef.current, snapshot.cursor);

		const next = toSummary(snapshot);
		const now = Date.now();
		const samples = samplesRef.current;
		samples.push({ at: now, settled: settledCount(next) });
		while (
			samples.length > 2 &&
			(samples[0]?.at ?? now) < now - RATE_WINDOW_MS
		) {
			samples.shift();
		}
		const first = samples[0];
		const last = samples[samples.length - 1];
		const span = first && last ? last.at - first.at : 0;
		const perMinute =
			first && last && span >= RATE_MIN_SPAN_MS
				? ((last.settled - first.settled) / span) * 60_000
				: 0;

		setSummary(next);
		setRate(perMinute > 0 ? perMinute : null);
		if (merged.changed) {
			const list: LoomImportItemView[] = [];
			for (const id of merged.order) {
				const item = map.get(id);
				if (item) list.push(item);
			}
			setItems(list);
		}
	}, []);

	const fetchSnapshot = useCallback(
		async (full = false) => {
			const params = new URLSearchParams({ jobId: initial.job.id });
			if (!full) params.set("since", String(cursorRef.current));
			const response = await fetch(`/api/import/loom/jobs?${params}`, {
				cache: "no-store",
				credentials: "same-origin",
			});
			if (!response.ok) throw new Error(`Snapshot failed: ${response.status}`);
			apply((await response.json()) as LoomImportSnapshot);
		},
		[apply, initial.job.id],
	);

	const loadedRest = useRef(initial.full);
	useEffect(() => {
		if (loadedRest.current) return;
		loadedRest.current = true;
		fetchSnapshot(true).catch(() => {
			loadedRest.current = false;
		});
	}, [fetchSnapshot]);

	const status = summary.job.status;
	const shouldPoll =
		isLoomImportJobActive(status) ||
		(status === "awaiting_upgrade" && watchForUpgrade);

	useEffect(() => {
		if (!shouldPoll) return;
		let stopped = false;
		let timer: number | undefined;
		let hiddenAt: number | null = null;

		const schedule = () => {
			if (stopped) return;
			const wait = document.hidden
				? HIDDEN_POLL_MS
				: status === "awaiting_upgrade"
					? UPGRADE_POLL_MS
					: ACTIVE_POLL_MS;
			timer = window.setTimeout(tick, wait);
		};

		const tick = () => {
			fetchSnapshot()
				.catch(() => undefined)
				.finally(schedule);
		};

		const onVisibility = () => {
			if (document.hidden) {
				hiddenAt = Date.now();
				return;
			}
			const full = hiddenAt !== null && Date.now() - hiddenAt > 60_000;
			hiddenAt = null;
			window.clearTimeout(timer);
			fetchSnapshot(full)
				.catch(() => undefined)
				.finally(schedule);
		};

		document.addEventListener("visibilitychange", onVisibility);
		schedule();
		return () => {
			stopped = true;
			window.clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [shouldPoll, status, fetchSnapshot]);

	const refresh = useCallback(() => fetchSnapshot(true), [fetchSnapshot]);

	return { summary, items, rate, refresh };
}
