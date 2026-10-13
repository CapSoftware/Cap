import { isConfigured, SERVICES } from "./services";
import type {
	Day,
	Health,
	MonitorState,
	ProbeResult,
	ServiceState,
	Snapshot,
} from "./types";

export const CHECK_INTERVAL_MS = 5 * 60_000;
export const STALE_AFTER_MS = 3 * CHECK_INTERVAL_MS;
export const HISTORY_DAYS = 90;
const DAY_MS = 86_400_000;

export function emptyState(): MonitorState {
	return { version: 1, checkedAt: null, services: {}, incidents: [] };
}

export function emptyService(): ServiceState {
	return {
		status: "unknown",
		checkedAt: null,
		latencyMs: null,
		failures: 0,
		successes: 0,
		issueStartedAt: null,
		incidentId: null,
		days: [],
	};
}

export function dates(now: number): string[] {
	return Array.from({ length: HISTORY_DAYS }, (_, index) =>
		new Date(now - (HISTORY_DAYS - 1 - index) * DAY_MS)
			.toISOString()
			.slice(0, 10),
	);
}

export function isStale(checkedAt: string | null, now: number): boolean {
	return !checkedAt || now - Date.parse(checkedAt) > STALE_AFTER_MS;
}

export function dayStatus(day: Day): Health {
	if (day.outage) return "outage";
	if (day.degraded) return "degraded";
	return day.operational ? "operational" : "unknown";
}

export function availability(days: Day[]): number | null {
	const observed = days.reduce(
		(sum, day) => sum + day.operational + day.degraded + day.outage,
		0,
	);
	return observed
		? (days.reduce((sum, day) => sum + day.operational, 0) / observed) * 100
		: null;
}

export function applyResult(
	state: MonitorState,
	id: string,
	result: ProbeResult | null,
	now: number,
): void {
	const previous = state.services[id] ?? emptyService();
	const time = new Date(now).toISOString();
	const cutoff = dates(now)[0];
	previous.days = previous.days.filter((day) => day.date >= cutoff);
	if (!result) {
		previous.status = "unknown";
		previous.checkedAt = null;
		previous.latencyMs = null;
		previous.failures = 0;
		previous.successes = 0;
		previous.issueStartedAt = null;
		state.services[id] = previous;
		return;
	}
	if (
		previous.checkedAt &&
		Math.floor(Date.parse(previous.checkedAt) / CHECK_INTERVAL_MS) >=
			Math.floor(now / CHECK_INTERVAL_MS)
	)
		return;
	if (isStale(previous.checkedAt, now)) {
		previous.failures = 0;
		previous.successes = 0;
		previous.issueStartedAt = null;
		previous.status = "unknown";
	}
	const day = previous.days.find(
		(entry) => entry.date === time.slice(0, 10),
	) ?? { date: time.slice(0, 10), operational: 0, degraded: 0, outage: 0 };
	if (!previous.days.includes(day)) previous.days.push(day);
	day[result.status]++;
	previous.checkedAt = time;
	previous.latencyMs = result.latencyMs;
	if (result.status === "operational") {
		previous.successes++;
		previous.failures = 0;
		previous.issueStartedAt = null;
		if (!previous.incidentId || previous.successes >= 2) {
			previous.status = "operational";
			const incident = state.incidents.find(
				(entry) => entry.id === previous.incidentId,
			);
			if (incident) incident.resolvedAt = time;
			previous.incidentId = null;
		}
	} else {
		previous.successes = 0;
		previous.failures++;
		previous.issueStartedAt ??= time;
		if (previous.failures >= 2) {
			previous.status = result.status;
			if (!previous.incidentId) {
				previous.incidentId = `${id}-${now}`;
				state.incidents.unshift({
					id: previous.incidentId,
					serviceId: id,
					severity: result.status,
					startedAt: previous.issueStartedAt,
					resolvedAt: null,
				});
			} else {
				const incident = state.incidents.find(
					(entry) => entry.id === previous.incidentId,
				);
				if (incident && result.status === "outage")
					incident.severity = "outage";
			}
		} else if (previous.status === "operational") {
			previous.status = "degraded";
		}
	}
	state.services[id] = previous;
	state.incidents = state.incidents
		.filter((entry) => !entry.resolvedAt)
		.concat(
			state.incidents
				.filter(
					(entry) =>
						entry.resolvedAt &&
						Date.parse(entry.resolvedAt) >= now - HISTORY_DAYS * DAY_MS,
				)
				.slice(0, 500),
		)
		.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

export function publicSnapshot(
	state: MonitorState,
	now = Date.now(),
): Snapshot {
	return {
		checkedAt: state.checkedAt,
		services: SERVICES.map((service) => {
			const saved = state.services[service.id] ?? emptyService();
			const configured = isConfigured(service);
			return {
				id: service.id,
				name: service.name,
				description: service.description,
				configured,
				status:
					!configured || isStale(saved.checkedAt, now)
						? "unknown"
						: saved.status,
				checkedAt: saved.checkedAt,
				latencyMs: saved.latencyMs,
				days: dates(now).map(
					(date) =>
						saved.days.find((day) => day.date === date) ?? {
							date,
							operational: 0,
							degraded: 0,
							outage: 0,
						},
				),
			};
		}),
		incidents: state.incidents.filter(
			(entry) =>
				!entry.resolvedAt ||
				Date.parse(entry.resolvedAt) >= now - HISTORY_DAYS * DAY_MS,
		),
	};
}
