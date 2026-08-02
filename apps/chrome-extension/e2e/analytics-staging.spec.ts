import { createHash, createHmac } from "node:crypto";
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

const percentile = (samples: readonly number[], value: number) => {
	if (samples.length === 0) throw new Error("Performance samples are required");
	const sorted = [...samples].sort((left, right) => left - right);
	return sorted[Math.ceil((value / 100) * sorted.length) - 1];
};

test("exact-SHA browser tracker preserves sessions, retries, unloads, and matched-control performance", async ({
	browser,
}) => {
	const previewUrl = requiredEnvironment("ANALYTICS_PREVIEW_URL");
	const runId = requiredEnvironment("ANALYTICS_BROWSER_RUN_ID");
	const statePath = requiredEnvironment("ANALYTICS_STATE_PATH");
	const artifactPath = requiredEnvironment("ANALYTICS_ARTIFACT_PATH");
	const expectedSha = requiredEnvironment("EXPECTED_SHA");
	const stagingSecret = requiredEnvironment(
		"CAP_ANALYTICS_STAGING_TEST_SECRET",
	);
	const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
	const shareSecret = process.env.VERCEL_PREVIEW_SHARE_SECRET?.trim();
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
	if (shareSecret) {
		const shareUrl = new URL("/api/analytics/staging-test/attest", previewUrl);
		shareUrl.searchParams.set("_vercel_share", shareSecret);
		const bootstrap = await context.request.get(shareUrl.toString(), {
			maxRedirects: 0,
		});
		expect([302, 303, 307, 308]).toContain(bootstrap.status());
	}
	const attestExactSha = async () => {
		const stagingSignature = createHmac("sha256", stagingSecret)
			.update(`${runId}:${expectedSha}`)
			.digest("hex");
		const response = await context.request.post(
			"/api/analytics/staging-test/attest",
			{
				data: { runId, sha: expectedSha },
				headers: {
					Authorization: `Bearer ${stagingSecret}`,
					"x-cap-analytics-staging-signature": stagingSignature,
				},
			},
		);
		expect(response.ok()).toBe(true);
		const payload = (await response.json()) as { sha?: string };
		expect(payload.sha).toBe(expectedSha);
	};
	await attestExactSha();
	const captured: CapturedEvent[] = [];
	const uniqueCapturedEvents = (eventName?: string) => [
		...new Map(
			captured
				.filter((event) => !eventName || event.eventName === eventName)
				.map((event) => [event.eventId, event]),
		).values(),
	];
	const acceptedEventIds = new Set<string>();
	const rejectedEventIds = new Set<string>();
	const benchmarkEventIds = new Set<string>();
	const requestAttempts = new Map<string, number>();
	const collectorStatusCounts = new Map<number, number>();
	const collectorRejections: Array<{
		eventNames: string[];
		status: number;
	}> = [];
	let invalidAcknowledgements = 0;
	let acceptedRequests = 0;
	let collectorRequests = 0;
	let failedRequests = 0;
	let benchmarking = false;
	context.on("request", (request) => {
		if (!request.url().endsWith("/api/events") || request.method() !== "POST") {
			return;
		}
		collectorRequests += 1;
		const events = requestEvents(request);
		if (
			benchmarking ||
			events.some((event) => benchmarkEventIds.has(event.eventId))
		) {
			return;
		}
		captured.push(...events);
		for (const event of events) {
			requestAttempts.set(
				event.eventId,
				(requestAttempts.get(event.eventId) ?? 0) + 1,
			);
		}
	});
	context.on("response", async (response) => {
		if (
			response.url().endsWith("/api/events") &&
			response.request().method() === "POST"
		) {
			const events = requestEvents(response.request());
			if (events.some((event) => benchmarkEventIds.has(event.eventId))) return;
			collectorStatusCounts.set(
				response.status(),
				(collectorStatusCounts.get(response.status()) ?? 0) + 1,
			);
			if (response.ok()) {
				const payload = (await response.json().catch(() => null)) as {
					acceptedEventIds?: unknown;
					rejectedEventIds?: unknown;
				} | null;
				if (
					payload &&
					Array.isArray(payload.acceptedEventIds) &&
					Array.isArray(payload.rejectedEventIds)
				) {
					acceptedRequests += 1;
					for (const eventId of payload.acceptedEventIds) {
						if (typeof eventId === "string") acceptedEventIds.add(eventId);
					}
					for (const eventId of payload.rejectedEventIds) {
						if (typeof eventId === "string") rejectedEventIds.add(eventId);
					}
				} else {
					invalidAcknowledgements += 1;
				}
			} else if (collectorRejections.length < 20) {
				collectorRejections.push({
					eventNames: [...new Set(events.map((event) => event.eventName))],
					status: response.status(),
				});
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
	try {
		await expect
			.poll(() => uniqueCapturedEvents("page_view").length)
			.toBeGreaterThanOrEqual(1);
	} catch {
		const pageState = await page.evaluate(() => {
			let queueState:
				| {
						hasState: true;
						queueLength: number;
						inFlightLength: number;
						delivery: Record<string, number>;
				  }
				| { hasState: false } = { hasState: false };
			try {
				const serialized = window.localStorage.getItem(
					"cap_analytics_queue_v1",
				);
				const parsed = serialized
					? (JSON.parse(serialized) as {
							queue?: unknown[];
							inFlight?: unknown[];
							delivery?: Record<string, unknown>;
						})
					: undefined;
				if (parsed) {
					queueState = {
						hasState: true,
						queueLength: parsed.queue?.length ?? 0,
						inFlightLength: parsed.inFlight?.length ?? 0,
						delivery: Object.fromEntries(
							Object.entries(parsed.delivery ?? {}).filter(
								(entry): entry is [string, number] =>
									typeof entry[1] === "number",
							),
						),
					};
				}
			} catch {}
			return {
				pathname: window.location.pathname,
				readyState: document.readyState,
				visibilityState: document.visibilityState,
				hasMain: document.querySelector("main") !== null,
				queueState,
			};
		});
		throw new Error(
			`Browser page_view was not captured: ${JSON.stringify({ collectorRequests, pageState })}`,
		);
	}
	const firstPageView = uniqueCapturedEvents("page_view")[0];
	expect(firstPageView?.properties?.is_session_entry).toBe(true);

	await page.reload({ waitUntil: "networkidle" });
	await expect
		.poll(() => uniqueCapturedEvents("page_view").length)
		.toBeGreaterThanOrEqual(2);
	const reloadPageView = uniqueCapturedEvents("page_view").at(-1);
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
		.poll(() => uniqueCapturedEvents("page_view").length)
		.toBeGreaterThanOrEqual(3);
	const activePageView = uniqueCapturedEvents("page_view").at(-1);
	expect(activePageView?.sessionId).toBe(firstPageView?.sessionId);

	const secondPage = await context.newPage();
	await secondPage.goto("/pricing", { waitUntil: "networkidle" });
	await expect
		.poll(() => uniqueCapturedEvents("page_view").length)
		.toBeGreaterThanOrEqual(4);
	const secondTabPageView = uniqueCapturedEvents("page_view").at(-1);
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
		.poll(() => uniqueCapturedEvents("page_view").length)
		.toBeGreaterThanOrEqual(5);
	const returnedPageView = uniqueCapturedEvents("page_view").at(-1);
	expect(returnedPageView?.sessionId).not.toBe(firstPageView?.sessionId);
	expect(returnedPageView?.properties?.is_session_entry).toBe(true);
	await expect
		.poll(
			() =>
				page.evaluate(() => {
					const serialized = localStorage.getItem("cap_analytics_queue_v1");
					if (!serialized) return true;
					const state = JSON.parse(serialized) as {
						inFlight?: unknown[];
						queue?: unknown[];
					};
					return (
						(state.queue?.length ?? 0) === 0 &&
						(state.inFlight?.length ?? 0) === 0
					);
				}),
			{ timeout: 15_000 },
		)
		.toBe(true);

	let abortNextCollectorRequest = true;
	const abortedEventIds = new Set<string>();
	await context.route("**/api/events", async (route) => {
		if (abortNextCollectorRequest) {
			abortNextCollectorRequest = false;
			for (const event of requestEvents(route.request())) {
				abortedEventIds.add(event.eventId);
			}
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
	expect(abortedEventIds.size).toBeGreaterThan(0);
	await context.unroute("**/api/events");
	try {
		await expect
			.poll(
				() =>
					[...abortedEventIds].every(
						(eventId) =>
							(requestAttempts.get(eventId) ?? 0) >= 2 &&
							acceptedEventIds.has(eventId),
					),
				{ timeout: 15_000 },
			)
			.toBe(true);
	} catch {
		throw new Error(
			`Browser retry was not acknowledged: ${JSON.stringify({
				abortedEventCount: abortedEventIds.size,
				abortedEventAttempts: [...abortedEventIds].map(
					(eventId) => requestAttempts.get(eventId) ?? 0,
				),
				abortedEventsAccepted: [...abortedEventIds].filter((eventId) =>
					acceptedEventIds.has(eventId),
				).length,
				abortedEventsRejected: [...abortedEventIds].filter((eventId) =>
					rejectedEventIds.has(eventId),
				).length,
				collectorRejections,
				collectorStatusCounts: Object.fromEntries(collectorStatusCounts),
				invalidAcknowledgements,
			})}`,
		);
	}
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
	const scenarioTaskDurationMs = Math.max(
		0,
		Math.round((afterTaskDuration - beforeTaskDuration) * 1_000),
	);

	const captureSampleCount = 30;
	let benchmarkCapturedEvents = 0;
	let benchmarkCapturedEngagementEvents = 0;
	await context.route("**/api/events", async (route) => {
		const events = requestEvents(route.request());
		benchmarkCapturedEvents += events.length;
		benchmarkCapturedEngagementEvents += events.filter(
			(event) => event.eventName === "page_engagement",
		).length;
		for (const event of events) benchmarkEventIds.add(event.eventId);
		await route.fulfill({
			body: JSON.stringify({
				accepted: events.length,
				acceptedEventIds: events.map((event) => event.eventId),
				rejectedEventIds: [],
			}),
			contentType: "application/json",
			status: 200,
		});
	});
	benchmarking = true;
	const longTaskSupported = await page.evaluate(() => {
		const benchmarkWindow = window as typeof window & {
			__capAnalyticsLongTaskObserver?: PerformanceObserver;
			__capAnalyticsLongTasks?: Array<{ duration: number; startTime: number }>;
		};
		benchmarkWindow.__capAnalyticsLongTaskObserver?.disconnect();
		benchmarkWindow.__capAnalyticsLongTasks = [];
		if (!PerformanceObserver.supportedEntryTypes.includes("longtask")) {
			return false;
		}
		const observer = new PerformanceObserver((entries) => {
			for (const entry of entries.getEntries()) {
				benchmarkWindow.__capAnalyticsLongTasks?.push({
					duration: entry.duration,
					startTime: entry.startTime,
				});
			}
		});
		observer.observe({ type: "longtask" });
		benchmarkWindow.__capAnalyticsLongTaskObserver = observer;
		Object.defineProperty(navigator, "sendBeacon", {
			configurable: true,
			value: () => false,
		});
		window.addEventListener("cap-analytics-control-pointerdown", () => {}, {
			passive: true,
		});
		window.addEventListener("cap-analytics-control-pagehide", () => {}, {
			passive: true,
		});
		return true;
	});
	expect(longTaskSupported).toBe(true);
	type DispatchMeasurement = {
		durationMs: number;
		endedAt: number;
		startedAt: number;
	};
	const dispatchMeasurement = async (
		control: boolean,
		event: "pagehide" | "pointerdown",
	): Promise<DispatchMeasurement> =>
		page.evaluate(
			({ control, event }) => {
				const startedAt = performance.now();
				if (control) {
					window.dispatchEvent(
						event === "pagehide"
							? new PageTransitionEvent("cap-analytics-control-pagehide")
							: new Event("cap-analytics-control-pointerdown"),
					);
				} else if (event === "pagehide") {
					window.dispatchEvent(new PageTransitionEvent("pagehide"));
				} else {
					window.dispatchEvent(new Event("pointerdown"));
				}
				const endedAt = performance.now();
				return { durationMs: endedAt - startedAt, endedAt, startedAt };
			},
			{ control, event },
		);
	const captureMeasurements: number[] = [];
	const controlMeasurements: number[] = [];
	const captureWindows: Array<{ endedAt: number; startedAt: number }> = [];
	const controlWindows: Array<{ endedAt: number; startedAt: number }> = [];
	const measureCapture = async (control: boolean) => {
		const pointer = await dispatchMeasurement(control, "pointerdown");
		await page.waitForTimeout(5);
		const pagehide = await dispatchMeasurement(control, "pagehide");
		const windows = control ? controlWindows : captureWindows;
		windows.push(pointer, pagehide);
		return pointer.durationMs + pagehide.durationMs;
	};
	for (let index = 0; index < captureSampleCount; index += 1) {
		if (index % 2 === 0) {
			controlMeasurements.push(await measureCapture(true));
			captureMeasurements.push(await measureCapture(false));
		} else {
			captureMeasurements.push(await measureCapture(false));
			controlMeasurements.push(await measureCapture(true));
		}
		await page.waitForTimeout(10);
	}
	await expect
		.poll(() => benchmarkCapturedEngagementEvents, { timeout: 15_000 })
		.toBeGreaterThanOrEqual(captureSampleCount);
	await page.waitForTimeout(100);
	const longTasks = await page.evaluate(() => {
		const benchmarkWindow = window as typeof window & {
			__capAnalyticsLongTaskObserver?: PerformanceObserver;
			__capAnalyticsLongTasks?: Array<{ duration: number; startTime: number }>;
		};
		benchmarkWindow.__capAnalyticsLongTaskObserver?.disconnect();
		return benchmarkWindow.__capAnalyticsLongTasks ?? [];
	});
	benchmarking = false;
	await context.unroute("**/api/events");
	const overlapsWindow = (
		entry: { duration: number; startTime: number },
		windows: ReadonlyArray<{ endedAt: number; startedAt: number }>,
	) =>
		windows.some(
			(window) =>
				entry.startTime < window.endedAt &&
				entry.startTime + entry.duration > window.startedAt,
		);
	const captureLongTasks = longTasks.filter((entry) =>
		overlapsWindow(entry, captureWindows),
	);
	const controlLongTasks = longTasks.filter((entry) =>
		overlapsWindow(entry, controlWindows),
	);
	const perEventDeltas = captureMeasurements.map((duration, index) =>
		Math.max(0, duration - controlMeasurements[index]),
	);
	const captureP50Ms = percentile(perEventDeltas, 50);
	const captureP95Ms = percentile(perEventDeltas, 95);
	const captureP99Ms = percentile(perEventDeltas, 99);
	const captureP95BudgetMs = Number(
		process.env.ANALYTICS_BROWSER_CAPTURE_P95_BUDGET_MS ?? 2,
	);
	const captureP99BudgetMs = Number(
		process.env.ANALYTICS_BROWSER_CAPTURE_P99_BUDGET_MS ?? 5,
	);
	const additionalLongTaskBudget = Number(
		process.env.ANALYTICS_BROWSER_LONG_TASK_BUDGET ?? 0,
	);
	expect(captureMeasurements).toHaveLength(captureSampleCount);
	expect(controlMeasurements).toHaveLength(captureSampleCount);
	expect(captureP95Ms).toBeLessThanOrEqual(captureP95BudgetMs);
	expect(captureP99Ms).toBeLessThanOrEqual(captureP99BudgetMs);
	expect(captureLongTasks.length).toBeLessThanOrEqual(
		controlLongTasks.length + additionalLongTaskBudget,
	);
	const uniqueEventIds = new Set(
		uniqueCapturedEvents().map((event) => event.eventId),
	);
	expect(uniqueEventIds.size).toBeGreaterThanOrEqual(6);
	expect(captured.some((event) => event.eventName === "page_engagement")).toBe(
		true,
	);
	const anonymousId = await page.evaluate(() =>
		localStorage.getItem("cap_analytics_anonymous_id_v1"),
	);
	if (!anonymousId) {
		throw new Error("Browser analytics anonymous identity was not persisted");
	}

	const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<
		string,
		unknown
	>;
	state.browserExpectedEvents = uniqueEventIds.size;
	state.browserAnonymousIdentityHash = createHash("sha256")
		.update(`anonymous\0${anonymousId}`)
		.digest("hex");
	fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, {
		mode: 0o600,
	});
	const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as Record<
		string,
		unknown
	> & { assertions?: Record<string, boolean> };
	artifact.browser = {
		acceptedRequests,
		acknowledgedEvents: acceptedEventIds.size,
		failedRequests,
		uniqueEvents: uniqueEventIds.size,
		pageViews: uniqueCapturedEvents("page_view").length,
		engagementEvents: uniqueCapturedEvents("page_engagement").length,
		sameTabReloadPassed: true,
		multiTabSessionPassed: true,
		activityAt29MinutesPassed: true,
		inactivityBoundaryPassed: true,
		offlineRetryPassed: true,
		unloadPassed: true,
		scenarioTaskDurationMs,
		capturePerformance: {
			capturedEngagementEvents: benchmarkCapturedEngagementEvents,
			capturedEvents: benchmarkCapturedEvents,
			captureP50Ms,
			captureP95BudgetMs,
			captureP95Ms,
			captureP99BudgetMs,
			captureP99Ms,
			captureSamples: captureMeasurements,
			controlP50Ms: percentile(controlMeasurements, 50),
			controlP95Ms: percentile(controlMeasurements, 95),
			controlP99Ms: percentile(controlMeasurements, 99),
			controlSamples: controlMeasurements,
			additionalLongTaskBudget,
			captureLongTaskCount: captureLongTasks.length,
			captureLongTaskMaxDurationMs: Math.max(
				0,
				...captureLongTasks.map((entry) => entry.duration),
			),
			controlLongTaskCount: controlLongTasks.length,
			controlLongTaskMaxDurationMs: Math.max(
				0,
				...controlLongTasks.map((entry) => entry.duration),
			),
			sampleCount: captureSampleCount,
		},
	};
	artifact.assertions = {
		...(artifact.assertions ?? {}),
		deployedBrowserTrackerPassed: true,
		browserMainThreadBudgetPassed: true,
	};
	fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
	await attestExactSha();
	await context.close();
});
