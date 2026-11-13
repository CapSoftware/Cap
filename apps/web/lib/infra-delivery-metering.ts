import type { Readable } from "node:stream";
import {
	addMethodTotals,
	cachedDeliveryResolver,
	type DeliveryMethodTotals,
	type DeliveryPart,
	type DeliveryResolver,
	type DeliveryTier,
	emptyMethodTotals,
	meterDeliveryLog,
} from "./infra-delivery-log";

export interface DeliveryRow {
	appId: string;
	tier: DeliveryTier;
	seconds: number;
	bytes: number;
	requests: number;
}

export interface DeliveryLogFile {
	file: string;
	etag: string;
	hour: Date;
}

export interface DeliveryLogSource {
	list(day: string): Promise<DeliveryLogFile[]>;
	open(file: string): Promise<Readable>;
}

export interface DeliveryDayState {
	final: boolean;
	updatedAt: Date;
}

export interface DeliveryStore {
	processedEtags(files: string[]): Promise<Map<string, string>>;
	saveFile(file: DeliveryLogFile, parts: DeliveryPart[]): Promise<void>;
	partsNear(from: Date, to: Date): Promise<DeliveryPart[]>;
	dayStates(from: string, to: string): Promise<Map<string, DeliveryDayState>>;
	replaceDay(
		day: string,
		rows: DeliveryRow[],
		now: Date,
		final: boolean,
	): Promise<"written" | "final">;
	finalizeDay(day: string, now: Date): Promise<void>;
	pruneFiles(before: Date): Promise<void>;
}

const LOG_LOCATION = /^s3:\/\/([a-z0-9.-]{3,63})\/(.+)$/;
const LOG_HOUR = /\.(\d{4}-\d{2}-\d{2})-(\d{2})\.[^/]+\.gz$/;

export interface DeliveryLogLocation {
	bucket: string;
	prefix: string;
}

export function readDeliveryLogLocation(
	value: string | undefined,
): DeliveryLogLocation | null {
	const match = value ? LOG_LOCATION.exec(value.trim()) : null;
	if (!match?.[1] || !match[2]) return null;
	return { bucket: match[1], prefix: match[2] };
}

export function deliveryLogHour(file: string): Date | null {
	const match = LOG_HOUR.exec(file);
	if (!match) return null;
	const hour = new Date(`${match[1]}T${match[2]}:00:00.000Z`);
	return Number.isNaN(hour.getTime()) ? null : hour;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const DELIVERY_FINAL_AFTER_MS = 2 * DAY_MS + 2 * 60 * 60 * 1000;
export const DELIVERY_LOG_RETENTION_DAYS = 14;
export const DELIVERY_METERING_FIRST_DAY = "2026-11-12";

function dayKey(date: Date) {
	return date.toISOString().slice(0, 10);
}

function dayStart(day: string) {
	return new Date(`${day}T00:00:00.000Z`);
}

function addDays(day: string, days: number) {
	return dayKey(new Date(dayStart(day).getTime() + days * DAY_MS));
}

export function deliveryDayFinalAt(day: string) {
	return new Date(dayStart(day).getTime() + DELIVERY_FINAL_AFTER_MS);
}

export function rollupDeliveryDay(
	day: string,
	parts: DeliveryPart[],
): DeliveryRow[] {
	const totals = new Map<string, DeliveryRow & { milliseconds: number }>();
	for (const [partDay, appId, , tier, requests, bytes, milliseconds] of parts) {
		if (partDay !== day) continue;
		const key = `${appId}\0${tier}`;
		const row = totals.get(key) ?? {
			appId,
			tier,
			seconds: 0,
			bytes: 0,
			requests: 0,
			milliseconds: 0,
		};
		row.milliseconds += milliseconds;
		row.bytes += bytes;
		row.requests += requests;
		totals.set(key, row);
	}
	return [...totals.values()]
		.map(({ milliseconds, ...row }) => ({
			...row,
			seconds: Math.round(milliseconds / 1000),
		}))
		.sort((a, b) =>
			a.appId === b.appId
				? a.tier.localeCompare(b.tier)
				: a.appId.localeCompare(b.appId),
		);
}

export interface DeliveryMeteringResult {
	recomputed: string[];
	finalized: string[];
	deferred: string[];
	listed: number;
	processed: number;
	failed: number;
	remaining: number;
	methods: DeliveryMethodTotals;
}

export async function runDeliveryMetering({
	source,
	store,
	resolver,
	now,
	maxFiles,
	outOfTime,
	concurrency = 4,
}: {
	source: DeliveryLogSource;
	store: DeliveryStore;
	resolver: DeliveryResolver;
	now: Date;
	maxFiles: number;
	outOfTime: () => boolean;
	concurrency?: number;
}): Promise<DeliveryMeteringResult> {
	const today = dayKey(now);
	const yesterday = addDays(today, -1);
	const oldest = [
		addDays(today, -(DELIVERY_LOG_RETENTION_DAYS - 1)),
		DELIVERY_METERING_FIRST_DAY,
	].sort()[1] as string;
	const lastClosed = addDays(today, -2);

	const states =
		oldest <= lastClosed
			? await store.dayStates(oldest, lastClosed)
			: new Map<string, DeliveryDayState>();
	const closing: { day: string; recompute: boolean }[] = [];
	for (let day = oldest; day <= lastClosed; day = addDays(day, 1)) {
		if (now < deliveryDayFinalAt(day)) continue;
		const state = states.get(day);
		if (state?.final) continue;
		closing.push({
			day,
			recompute: !state || state.updatedAt < dayStart(addDays(day, 1)),
		});
	}

	const listDays = new Set([yesterday, today]);
	for (const { day, recompute } of closing) {
		if (!recompute) continue;
		listDays.add(day);
		listDays.add(addDays(day, 1));
	}
	const listed = (
		await Promise.all([...listDays].sort().map((day) => source.list(day)))
	).flat();
	const known = await store.processedEtags(listed.map((file) => file.file));
	const due = listed
		.filter((file) => known.get(file.file) !== file.etag)
		.sort((a, b) => a.file.localeCompare(b.file));

	const cached = cachedDeliveryResolver(resolver);
	const unsettled = new Set<string>();
	const methods = emptyMethodTotals();
	let next = 0;
	let processed = 0;
	let failed = 0;
	const worker = async () => {
		while (next < due.length && next < maxFiles && !outOfTime()) {
			const file = due[next++];
			if (!file) return;
			try {
				const metered = await meterDeliveryLog(
					await source.open(file.file),
					cached,
				);
				await store.saveFile(file, metered.parts);
				addMethodTotals(methods, metered.methods);
				processed++;
			} catch (error) {
				failed++;
				unsettled.add(file.file);
				console.error("[developer-delivery] Log file not metered", {
					file: file.file,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	};
	await Promise.all(Array.from({ length: concurrency }, worker));
	for (const file of due.slice(next)) unsettled.add(file.file);

	const rowsFor = async (day: string) => {
		const start = dayStart(day);
		const parts = await store.partsNear(
			new Date(start.getTime() - DAY_MS),
			new Date(start.getTime() + 2 * DAY_MS),
		);
		return rollupDeliveryDay(day, parts);
	};

	const recomputed: string[] = [];
	for (const day of [yesterday, today]) {
		if (
			(await store.replaceDay(day, await rowsFor(day), now, false)) ===
			"written"
		) {
			recomputed.push(day);
		}
	}

	const finalized: string[] = [];
	const deferred: string[] = [];
	for (const { day, recompute } of closing) {
		if (!recompute) {
			await store.finalizeDay(day, now);
			finalized.push(day);
			continue;
		}
		const covering = [`.${day}-`, `.${addDays(day, 1)}-`];
		const waiting = [...unsettled].some((file) =>
			covering.some((marker) => file.includes(marker)),
		);
		if (waiting) {
			deferred.push(day);
			continue;
		}
		await store.replaceDay(day, await rowsFor(day), now, true);
		finalized.push(day);
	}

	if (processed > 0) {
		console.info("[developer-delivery] Seconds by method", {
			seconds: Object.fromEntries(
				Object.entries(methods.seconds).map(([method, seconds]) => [
					method,
					Math.round(seconds),
				]),
			),
			requests: methods.requests,
			unlabelled: methods.unlabelled,
		});
	}

	await store.pruneFiles(
		new Date(now.getTime() - (DELIVERY_LOG_RETENTION_DAYS + 2) * DAY_MS),
	);

	return {
		recomputed,
		finalized,
		deferred,
		listed: listed.length,
		processed,
		failed,
		remaining: due.length - processed - failed,
		methods,
	};
}
