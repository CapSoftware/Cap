import { describe, expect, test } from "bun:test";
import {
	applyResult,
	availability,
	CHECK_INTERVAL_MS,
	dates,
	dayStatus,
	emptyState,
	firstMonitoredDay,
	isStale,
	publicSnapshot,
	STALE_AFTER_MS,
} from "../lib/state";

const start = Date.UTC(2026, 9, 13, 12);
const good = { status: "operational" as const, latencyMs: 120 };
const bad = { status: "outage" as const, latencyMs: 8_000 };

describe("monitor state", () => {
	test("does not invent history or healthy services before the first check", () => {
		const snapshot = publicSnapshot(emptyState(), start);
		expect(snapshot.services).toHaveLength(6);
		expect(
			snapshot.services.every((service) => service.status === "unknown"),
		).toBe(true);
		expect(snapshot.services[0].days).toHaveLength(90);
		expect(availability(snapshot.services[0].days)).toBeNull();
	});

	test("confirms an incident and recovery over two consecutive samples", () => {
		const state = emptyState();
		applyResult(state, "website", good, start);
		applyResult(state, "website", bad, start + CHECK_INTERVAL_MS);
		expect(state.services.website.status).toBe("degraded");
		expect(state.incidents).toHaveLength(0);
		applyResult(state, "website", bad, start + 2 * CHECK_INTERVAL_MS);
		expect(state.services.website.status).toBe("outage");
		expect(state.incidents).toHaveLength(1);
		expect(state.incidents[0].startedAt).toBe(
			new Date(start + CHECK_INTERVAL_MS).toISOString(),
		);
		applyResult(state, "website", good, start + 3 * CHECK_INTERVAL_MS);
		expect(state.services.website.status).toBe("outage");
		expect(state.incidents[0].resolvedAt).toBeNull();
		applyResult(state, "website", good, start + 4 * CHECK_INTERVAL_MS);
		expect(state.services.website.status).toBe("operational");
		expect(state.incidents[0].resolvedAt).toBe(
			new Date(start + 4 * CHECK_INTERVAL_MS).toISOString(),
		);
		expect(state.incidents).toHaveLength(1);
	});

	test("ignores duplicate and out-of-order samples", () => {
		const state = emptyState();
		applyResult(state, "website", good, start);
		applyResult(state, "website", bad, start + CHECK_INTERVAL_MS - 1);
		applyResult(state, "website", bad, start - CHECK_INTERVAL_MS);
		expect(state.services.website.days[0].operational).toBe(1);
		expect(state.services.website.days[0].outage).toBe(0);
		expect(state.services.website.status).toBe("operational");
	});

	test("does not combine failures separated by a monitoring gap", () => {
		const state = emptyState();
		applyResult(state, "website", bad, start);
		applyResult(state, "website", bad, start + STALE_AFTER_MS + 1);
		expect(state.incidents).toHaveLength(0);
		expect(state.services.website.status).toBe("unknown");
	});

	test("marks old observations unknown without erasing the incident or history", () => {
		const state = emptyState();
		applyResult(state, "website", bad, start);
		applyResult(state, "website", bad, start + CHECK_INTERVAL_MS);
		const snapshot = publicSnapshot(
			state,
			start + CHECK_INTERVAL_MS + STALE_AFTER_MS + 1,
		);
		expect(snapshot.services[0].status).toBe("unknown");
		expect(snapshot.incidents[0].resolvedAt).toBeNull();
		expect(availability(snapshot.services[0].days)).toBe(0);
	});

	test("retains exactly 90 calendar days across UTC boundaries", () => {
		const state = emptyState();
		applyResult(state, "website", good, start - 90 * 86_400_000);
		applyResult(state, "website", good, start - 89 * 86_400_000);
		applyResult(state, "website", good, start);
		expect(state.services.website.days).toHaveLength(2);
		expect(dates(start)).toHaveLength(90);
		expect(dates(start).at(-1)).toBe("2026-10-13");
		expect(
			isStale(new Date(start).toISOString(), start + STALE_AFTER_MS + 1),
		).toBe(true);
	});

	test("unconfigured services stay unknown and do not manufacture an outage", () => {
		const state = emptyState();
		applyResult(state, "media", null, start);
		expect(state.services.media.status).toBe("unknown");
		expect(state.services.media.days).toHaveLength(0);
		expect(state.incidents).toHaveLength(0);
	});

	test("reports observed availability without filling gaps with successes", () => {
		expect(
			availability([
				{ date: "2026-10-13", operational: 9, degraded: 0, outage: 1 },
			]),
		).toBe(90);
		expect(
			availability([
				{ date: "2026-10-13", operational: 0, degraded: 0, outage: 0 },
			]),
		).toBeNull();
	});

	test("expired resolved incidents disappear even when the collector stops", () => {
		const state = emptyState();
		state.incidents = [
			{
				id: "old",
				serviceId: "website",
				severity: "outage",
				startedAt: new Date(start - 92 * 86_400_000).toISOString(),
				resolvedAt: new Date(start - 91 * 86_400_000).toISOString(),
			},
			{
				id: "ongoing",
				serviceId: "website",
				severity: "outage",
				startedAt: new Date(start - 92 * 86_400_000).toISOString(),
				resolvedAt: null,
			},
		];
		expect(
			publicSnapshot(state, start).incidents.map((entry) => entry.id),
		).toEqual(["ongoing"]);
	});

	test("shows a day as an outage only when an outage was confirmed", () => {
		const state = emptyState();
		applyResult(state, "render", good, start);
		applyResult(state, "render", bad, start + CHECK_INTERVAL_MS);
		applyResult(state, "render", good, start + 2 * CHECK_INTERVAL_MS);
		applyResult(state, "render", bad, start + 3 * CHECK_INTERVAL_MS);
		applyResult(state, "render", good, start + 4 * CHECK_INTERVAL_MS);
		let snapshot = publicSnapshot(state, start + 4 * CHECK_INTERVAL_MS);
		let today = snapshot.services
			.find((service) => service.id === "render")
			?.days.at(-1);
		expect(today?.outage).toBe(2);
		expect(snapshot.incidents).toHaveLength(0);
		expect(today && dayStatus(today, snapshot.incidents)).toBe("degraded");

		applyResult(state, "render", bad, start + 5 * CHECK_INTERVAL_MS);
		applyResult(state, "render", bad, start + 6 * CHECK_INTERVAL_MS);
		snapshot = publicSnapshot(state, start + 6 * CHECK_INTERVAL_MS);
		today = snapshot.services
			.find((service) => service.id === "render")
			?.days.at(-1);
		expect(snapshot.incidents).toHaveLength(1);
		expect(today && dayStatus(today, snapshot.incidents)).toBe("outage");
		expect(
			today &&
				dayStatus(
					today,
					snapshot.incidents.map((incident) => ({
						...incident,
						serviceId: "website",
						severity: "degraded" as const,
					})),
				),
		).toBe("degraded");
	});

	test("confirmed outages colour every day they span", () => {
		const incident = {
			id: "long",
			serviceId: "render",
			severity: "outage" as const,
			startedAt: "2026-10-12T23:50:00.000Z",
			resolvedAt: "2026-10-14T00:10:00.000Z",
		};
		const day = (date: string) => ({
			date,
			operational: 1,
			degraded: 0,
			outage: 1,
		});
		expect(dayStatus(day("2026-10-12"), [incident])).toBe("outage");
		expect(dayStatus(day("2026-10-13"), [incident])).toBe("outage");
		expect(dayStatus(day("2026-10-14"), [incident])).toBe("outage");
		expect(dayStatus(day("2026-10-15"), [incident])).toBe("degraded");
		expect(
			dayStatus(day("2026-10-20"), [{ ...incident, resolvedAt: null }]),
		).toBe("outage");
	});

	test("history starts at the first monitored day across services", () => {
		const state = emptyState();
		expect(firstMonitoredDay(publicSnapshot(state, start).services)).toBe(0);
		applyResult(state, "media", good, start - 3 * 86_400_000);
		applyResult(state, "website", good, start - 86_400_000);
		const services = publicSnapshot(state, start).services;
		expect(firstMonitoredDay(services)).toBe(86);
		expect(services[0].days[86].date).toBe("2026-10-10");
	});
});
