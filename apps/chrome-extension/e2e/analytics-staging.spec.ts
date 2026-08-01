import fs from "node:fs";
import { expect, test } from "@playwright/test";

type CapturedEvent = {
	eventId: string;
	eventName: string;
	sessionId: string;
	properties?: { is_session_entry?: boolean };
};

const requestEvents = (request: {
	postData: () => string | null;
}): CapturedEvent[] => {
	try {
		const payload = JSON.parse(request.postData() ?? "{}") as {
			events?: CapturedEvent[];
		};
		return payload.events ?? [];
	} catch {
		return [];
	}
};

const requiredEnvironment = (name: string) => {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
};

test("exact-SHA browser tracker preserves sessions, retries, unloads, and its main-thread budget", async ({
	browser,
}) => {
	const previewUrl = requiredEnvironment("ANALYTICS_PREVIEW_URL");
	const runId = requiredEnvironment("ANALYTICS_BROWSER_RUN_ID");
	const statePath = requiredEnvironment("ANALYTICS_STATE_PATH");
	const artifactPath = requiredEnvironment("ANALYTICS_ARTIFACT_PATH");
	const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
	const context = await browser.newContext({
		baseURL: previewUrl,
		extraHTTPHeaders: {
			"x-cap-analytics-test-run": runId,
			...(bypass
				? {
						"x-vercel-protection-bypass": bypass,
						"x-vercel-set-bypass-cookie": "true",
					}
				: {}),
		},
	});
	const captured: CapturedEvent[] = [];
	const acceptedEventIds = new Set<string>();
	let acceptedRequests = 0;
	let failedRequests = 0;
	context.on("request", (request) => {
		if (!request.url().endsWith("/api/events") || request.method() !== "POST") {
			return;
		}
		captured.push(...requestEvents(request));
	});
	context.on("response", (response) => {
		if (
			response.url().endsWith("/api/events") &&
			response.request().method() === "POST"
		) {
			if (response.ok()) {
				acceptedRequests += 1;
				for (const event of requestEvents(response.request())) {
					acceptedEventIds.add(event.eventId);
				}
			}
		}
	});
	context.on("requestfailed", (request) => {
		if (request.url().endsWith("/api/events")) failedRequests += 1;
	});

	const page = await context.newPage();
	const cdp = await context.newCDPSession(page);
	await cdp.send("Performance.enable");
	const taskDuration = async () => {
		const metrics = await cdp.send("Performance.getMetrics");
		return (
			metrics.metrics.find((metric) => metric.name === "TaskDuration")?.value ??
			0
		);
	};
	const beforeTaskDuration = await taskDuration();
	await page.goto("/?utm_source=staging-browser&utm_medium=e2e", {
		waitUntil: "networkidle",
	});
	await expect
		.poll(
			() => captured.filter((event) => event.eventName === "page_view").length,
		)
		.toBeGreaterThanOrEqual(1);
	const firstPageView = captured.find(
		(event) => event.eventName === "page_view",
	);
	expect(firstPageView?.properties?.is_session_entry).toBe(true);

	await page.reload({ waitUntil: "networkidle" });
	await expect
		.poll(
			() => captured.filter((event) => event.eventName === "page_view").length,
		)
		.toBeGreaterThanOrEqual(2);
	const reloadPageView = captured
		.filter((event) => event.eventName === "page_view")
		.at(-1);
	expect(reloadPageView?.sessionId).toBe(firstPageView?.sessionId);
	expect(reloadPageView?.properties?.is_session_entry).toBe(false);

	await page.evaluate(() => {
		const key = "cap_analytics_session_v2";
		const value = JSON.parse(localStorage.getItem(key) ?? "null") as {
			lastActivityAt?: number;
		} | null;
		if (!value || typeof value.lastActivityAt !== "number") {
			throw new Error("Browser analytics session was not persisted");
		}
		value.lastActivityAt = Date.now() - 29 * 60 * 1_000;
		localStorage.setItem(key, JSON.stringify(value));
	});
	await page.reload({ waitUntil: "networkidle" });
	await expect
		.poll(
			() => captured.filter((event) => event.eventName === "page_view").length,
		)
		.toBeGreaterThanOrEqual(3);
	const activePageView = captured
		.filter((event) => event.eventName === "page_view")
		.at(-1);
	expect(activePageView?.sessionId).toBe(firstPageView?.sessionId);

	const secondPage = await context.newPage();
	await secondPage.goto("/pricing", { waitUntil: "networkidle" });
	await expect
		.poll(
			() => captured.filter((event) => event.eventName === "page_view").length,
		)
		.toBeGreaterThanOrEqual(4);
	const secondTabPageView = captured
		.filter((event) => event.eventName === "page_view")
		.at(-1);
	expect(secondTabPageView?.sessionId).toBe(firstPageView?.sessionId);
	await secondPage.close();

	await page.evaluate(() => {
		const key = "cap_analytics_session_v2";
		const value = JSON.parse(localStorage.getItem(key) ?? "null") as {
			lastActivityAt?: number;
		} | null;
		if (!value || typeof value.lastActivityAt !== "number") {
			throw new Error("Browser analytics session was not persisted");
		}
		value.lastActivityAt = Date.now() - (30 * 60 * 1_000 + 1);
		localStorage.setItem(key, JSON.stringify(value));
	});
	await page.reload({ waitUntil: "networkidle" });
	await expect
		.poll(
			() => captured.filter((event) => event.eventName === "page_view").length,
		)
		.toBeGreaterThanOrEqual(5);
	const returnedPageView = captured
		.filter((event) => event.eventName === "page_view")
		.at(-1);
	expect(returnedPageView?.sessionId).not.toBe(firstPageView?.sessionId);
	expect(returnedPageView?.properties?.is_session_entry).toBe(true);

	let abortNextCollectorRequest = true;
	await context.route("**/api/events", async (route) => {
		if (abortNextCollectorRequest) {
			abortNextCollectorRequest = false;
			await route.abort("internetdisconnected");
			return;
		}
		await route.continue();
	});
	await page
		.locator('a[href="/pricing"]')
		.first()
		.evaluate((element) => {
			(element as HTMLAnchorElement).click();
		});
	await expect(page).toHaveURL(/\/pricing/);
	await expect
		.poll(() => failedRequests, { timeout: 15_000 })
		.toBeGreaterThanOrEqual(1);
	await context.unroute("**/api/events");
	await expect
		.poll(() => acceptedEventIds.size, { timeout: 15_000 })
		.toBeGreaterThanOrEqual(6);
	await page.evaluate(() => window.dispatchEvent(new Event("pointerdown")));
	await page.waitForTimeout(100);
	await page.evaluate(() =>
		window.dispatchEvent(new PageTransitionEvent("pagehide")),
	);
	await expect
		.poll(
			() =>
				captured
					.filter((event) => event.eventName === "page_engagement")
					.some((event) => acceptedEventIds.has(event.eventId)),
			{ timeout: 15_000 },
		)
		.toBe(true);

	const afterTaskDuration = await taskDuration();
	const interactionTaskDurationMs = Math.max(
		0,
		Math.round((afterTaskDuration - beforeTaskDuration) * 1_000),
	);
	const taskDurationBudgetMs = Number(
		process.env.ANALYTICS_BROWSER_TASK_BUDGET_MS ?? 1_500,
	);
	expect(interactionTaskDurationMs).toBeLessThanOrEqual(taskDurationBudgetMs);
	const uniqueEventIds = new Set(captured.map((event) => event.eventId));
	expect(uniqueEventIds.size).toBeGreaterThanOrEqual(6);
	expect(
		[...uniqueEventIds].every((eventId) => acceptedEventIds.has(eventId)),
	).toBe(true);
	expect(captured.some((event) => event.eventName === "page_engagement")).toBe(
		true,
	);

	const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<
		string,
		unknown
	>;
	state.browserExpectedEvents = acceptedEventIds.size;
	fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, {
		mode: 0o600,
	});
	const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as Record<
		string,
		unknown
	> & { assertions?: Record<string, boolean> };
	artifact.browser = {
		acceptedRequests,
		failedRequests,
		uniqueEvents: acceptedEventIds.size,
		pageViews: captured.filter((event) => event.eventName === "page_view")
			.length,
		engagementEvents: captured.filter(
			(event) => event.eventName === "page_engagement",
		).length,
		sameTabReloadPassed: true,
		multiTabSessionPassed: true,
		activityAt29MinutesPassed: true,
		inactivityBoundaryPassed: true,
		offlineRetryPassed: true,
		unloadPassed: true,
		interactionTaskDurationMs,
		taskDurationBudgetMs,
	};
	artifact.assertions = {
		...(artifact.assertions ?? {}),
		deployedBrowserTrackerPassed: true,
		browserMainThreadBudgetPassed: true,
	};
	fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
	await context.close();
});
