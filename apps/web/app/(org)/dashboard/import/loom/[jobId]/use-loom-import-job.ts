"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
	isLoomImportJobActive,
	type LoomImportItemView,
	type LoomImportJobStatus,
	type LoomImportJobView,
	type LoomImportSnapshot,
	type LoomImportSummaryView,
	loomImportWaitingStatus,
	summarizeLoomImportItems,
} from "@/lib/loom-import/status";

const ACTIVE_POLL_MS = 4000;
const IDLE_POLL_MS = 15_000;
const UPGRADE_POLL_MS = 2500;
const FULL_REFRESH_MS = 180_000;
const SNAPSHOT_TIMEOUT_MS = 20_000;
const RATE_WINDOW_MS = 180_000;
const RATE_MIN_SPAN_MS = 20_000;

export type LoomImportSummary = LoomImportSummaryView & {
	job: LoomImportJobView;
};

type RateSample = { at: number; settled: number };

function settledCount(summary: LoomImportSummaryView) {
	const { imported, failed, skipped, cancelled } = summary.counts;
	return imported + failed + skipped + cancelled;
}

export function mergeLoomImportItems(
	map: Map<string, LoomImportItemView>,
	order: string[],
	snapshot: LoomImportSnapshot,
	previousJobStatus: LoomImportJobStatus = snapshot.job.status,
) {
	let nextOrder = order;
	if (snapshot.full) {
		map.clear();
		nextOrder = snapshot.items.map((item) => item.id);
	}
	let changed = snapshot.full;
	if (!snapshot.full && previousJobStatus !== snapshot.job.status) {
		const waiting = loomImportWaitingStatus(snapshot.job.status);
		for (const [id, item] of map) {
			if (
				(item.status === "ready" || item.status === "queued") &&
				item.status !== waiting
			) {
				map.set(id, { ...item, status: waiting });
				changed = true;
			}
		}
	}
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
	const jobStatusRef = useRef(initial.job.status);
	const hasAllRef = useRef(initial.full);
	const fullAtRef = useRef(initial.full ? Date.now() : 0);
	const summaryRef = useRef<LoomImportSummaryView>(
		initial.summary ?? summarizeLoomImportItems(initial.items),
	);
	const queueRef = useRef<Promise<void>>(Promise.resolve());
	const pollDelayRef = useRef(ACTIVE_POLL_MS);
	const samplesRef = useRef<RateSample[]>([]);
	if (itemsRef.current === null) {
		itemsRef.current = new Map(initial.items.map((item) => [item.id, item]));
		orderRef.current = initial.items.map((item) => item.id);
	}

	const [items, setItems] = useState<LoomImportItemView[]>(initial.items);
	const [summary, setSummary] = useState<LoomImportSummary>(() => ({
		job: initial.job,
		...summaryRef.current,
	}));
	const [rate, setRate] = useState<number | null>(null);

	const apply = useCallback((snapshot: LoomImportSnapshot) => {
		const map = itemsRef.current;
		if (!map) return;
		const merged = mergeLoomImportItems(
			map,
			orderRef.current,
			snapshot,
			jobStatusRef.current,
		);
		orderRef.current = merged.order;
		cursorRef.current = Math.max(cursorRef.current, snapshot.cursor);
		jobStatusRef.current = snapshot.job.status;
		if (snapshot.full) {
			hasAllRef.current = true;
			fullAtRef.current = Date.now();
		}
		if (snapshot.summary) {
			summaryRef.current = snapshot.summary;
		} else if (hasAllRef.current && merged.changed) {
			summaryRef.current = summarizeLoomImportItems(map.values());
		}
		pollDelayRef.current = merged.changed
			? ACTIVE_POLL_MS
			: Math.min(IDLE_POLL_MS, Math.round(pollDelayRef.current * 1.5));

		const now = Date.now();
		const samples = samplesRef.current;
		samples.push({ at: now, settled: settledCount(summaryRef.current) });
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

		setSummary({ job: snapshot.job, ...summaryRef.current });
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
		(full = false) => {
			const run = async () => {
				const params = new URLSearchParams({ jobId: initial.job.id });
				if (!full) params.set("since", String(cursorRef.current));
				const response = await fetch(`/api/import/loom/jobs?${params}`, {
					cache: "no-store",
					credentials: "same-origin",
					signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
				});
				if (!response.ok)
					throw new Error(`Snapshot failed: ${response.status}`);
				apply((await response.json()) as LoomImportSnapshot);
			};
			const request = queueRef.current.then(run, run);
			queueRef.current = request.catch(() => undefined);
			return request;
		},
		[apply, initial.job.id],
	);

	useEffect(() => {
		if (initial.full) return;
		let stopped = false;
		let timer: number | undefined;
		const load = (attempt: number) => {
			fetchSnapshot(true).catch(() => {
				if (stopped || attempt >= 4) return;
				timer = window.setTimeout(() => load(attempt + 1), 1000 * 2 ** attempt);
			});
		};
		load(0);
		return () => {
			stopped = true;
			window.clearTimeout(timer);
		};
	}, [initial.full, fetchSnapshot]);

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
			window.clearTimeout(timer);
			if (stopped || document.hidden) return;
			const wait =
				status === "awaiting_upgrade" ? UPGRADE_POLL_MS : pollDelayRef.current;
			timer = window.setTimeout(tick, wait);
		};

		const tick = () => {
			const full =
				hasAllRef.current && Date.now() - fullAtRef.current > FULL_REFRESH_MS;
			fetchSnapshot(full)
				.catch(() => undefined)
				.finally(schedule);
		};

		const onVisibility = () => {
			if (document.hidden) {
				hiddenAt = Date.now();
				window.clearTimeout(timer);
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
