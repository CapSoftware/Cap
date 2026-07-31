import { describe, expect, it } from "vitest";
import {
	PRODUCT_ANALYTICS_SESSION_TIMEOUT_MS,
	readAnalyticsTouch,
	resolveBrowserAnalyticsContext,
} from "./browser-session";

function createStorage() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	};
}

function createIds() {
	let id = 0;
	return () => `session-${++id}`;
}

describe("browser analytics sessions", () => {
	it("shares a session across reloads and tabs", () => {
		const storage = createStorage();
		const createId = createIds();
		const firstTab = resolveBrowserAnalyticsContext({
			storage,
			createId,
			now: 1_000,
		});
		const reloadedTab = resolveBrowserAnalyticsContext({
			storage,
			createId,
			now: 2_000,
		});
		const secondTab = resolveBrowserAnalyticsContext({
			storage,
			createId,
			now: 3_000,
		});

		expect(firstTab).toMatchObject({
			sessionId: "session-1",
			isSessionEntry: true,
		});
		expect(reloadedTab).toMatchObject({
			sessionId: "session-1",
			isSessionEntry: false,
		});
		expect(secondTab).toMatchObject({
			sessionId: "session-1",
			isSessionEntry: false,
		});
	});

	it("extends activity at 29 minutes and starts after more than 30 minutes", () => {
		const storage = createStorage();
		const createId = createIds();
		resolveBrowserAnalyticsContext({ storage, createId, now: 0 });
		const active = resolveBrowserAnalyticsContext({
			storage,
			createId,
			now: 29 * 60 * 1000,
		});
		const extended = resolveBrowserAnalyticsContext({
			storage,
			createId,
			now: 59 * 60 * 1000,
		});
		const returned = resolveBrowserAnalyticsContext({
			storage,
			createId,
			now: 59 * 60 * 1000 + PRODUCT_ANALYTICS_SESSION_TIMEOUT_MS + 1,
		});

		expect(active.sessionId).toBe("session-1");
		expect(extended.sessionId).toBe("session-1");
		expect(returned).toMatchObject({
			sessionId: "session-2",
			isSessionEntry: true,
		});
	});

	it("keeps first and session touch stable while updating last touch", () => {
		const storage = createStorage();
		const createId = createIds();
		const firstTouch = readAnalyticsTouch(
			"?utm_source=search&utm_campaign=one",
			0,
		);
		const first = resolveBrowserAnalyticsContext({
			storage,
			createId,
			now: 0,
			touch: firstTouch,
		});
		const secondTouch = readAnalyticsTouch("?utm_source=partner", 1_000);
		const sameSession = resolveBrowserAnalyticsContext({
			storage,
			createId,
			now: 1_000,
			touch: secondTouch,
		});
		const nextSession = resolveBrowserAnalyticsContext({
			storage,
			createId,
			now: PRODUCT_ANALYTICS_SESSION_TIMEOUT_MS + 2_000,
			touch: secondTouch,
		});

		expect(first.attribution).toMatchObject({
			first_touch_source: "search",
			session_touch_source: "search",
			last_touch_source: "search",
		});
		expect(sameSession.attribution).toMatchObject({
			first_touch_source: "search",
			session_touch_source: "search",
			last_touch_source: "partner",
		});
		expect(nextSession.attribution).toMatchObject({
			first_touch_source: "search",
			session_touch_source: "partner",
			last_touch_source: "partner",
		});
	});

	it("starts a new session after the clock moves backwards", () => {
		const storage = createStorage();
		const createId = createIds();
		resolveBrowserAnalyticsContext({ storage, createId, now: 10_000 });
		const context = resolveBrowserAnalyticsContext({
			storage,
			createId,
			now: 1_000,
		});
		expect(context.sessionId).toBe("session-2");
	});
});
