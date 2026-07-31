import { describe, expect, it } from "vitest";
import {
	CORE_EVENT_NAMES,
	createProductEventPayloadHash,
	createProductEventRows,
	isCoreEventName,
	isServerOnlyEventName,
	normalizeProductEventInput,
	normalizeProductEventProperties,
	PRODUCT_ANALYTICS_LIMITS,
} from "./index";

describe("product analytics contract", () => {
	it("keeps the catalog unique and consistently named", () => {
		expect(new Set(CORE_EVENT_NAMES).size).toBe(CORE_EVENT_NAMES.length);
		for (const name of CORE_EVENT_NAMES) {
			expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
		}
	});

	it("rejects noisy events outside the core catalog", () => {
		expect(isCoreEventName("recording_started")).toBe(true);
		expect(isCoreEventName("mouse_moved")).toBe(false);
		expect(isCoreEventName("$autocapture")).toBe(false);
	});

	it("marks revenue and lifecycle events as server authoritative", () => {
		expect(isServerOnlyEventName("purchase_completed")).toBe(true);
		expect(isServerOnlyEventName("user_signed_up")).toBe(true);
		expect(isServerOnlyEventName("page_view")).toBe(false);
		expect(isServerOnlyEventName("recording_completed")).toBe(false);
	});
});

describe("normalizeProductEventProperties", () => {
	it("accepts only the declared schema and value types", () => {
		expect(
			normalizeProductEventProperties("auth_started", {
				method: "email",
				is_signup: true,
				auth_surface: "signup",
			}),
		).toEqual({
			method: "email",
			is_signup: true,
			auth_surface: "signup",
		});
	});

	it("rejects unknown property keys instead of silently dropping them", () => {
		expect(
			normalizeProductEventProperties("auth_started", {
				method: "email",
				is_signup: true,
				auth_surface: "signup",
				email: "private@example.com",
			}),
		).toBeNull();
	});

	it("rejects missing required fields, invalid enums and non-finite numbers", () => {
		expect(
			normalizeProductEventProperties("auth_started", {
				method: "sms",
				is_signup: true,
			}),
		).toBeNull();
		expect(
			normalizeProductEventProperties("page_engagement", {
				engaged_ms: Number.POSITIVE_INFINITY,
				max_scroll_depth: 50,
			}),
		).toBeNull();
	});

	it("rejects overlong string values", () => {
		const longValue = "x".repeat(
			PRODUCT_ANALYTICS_LIMITS.propertyStringLength + 20,
		);
		expect(
			normalizeProductEventProperties("tool_interaction", {
				tool: "trimmer",
				action: "process_failed",
				failure_class: longValue,
			}),
		).toBeNull();
	});

	it("rejects PII, credentials, filenames, URLs, and raw errors in allowed fields", () => {
		for (const campaign of [
			"alice@example.com",
			"+44 7700 900123",
			"https://example.com/customer?email=private",
			"authorization=private-value",
			"customer-recording.mp4",
		]) {
			expect(
				normalizeProductEventProperties("page_view", {
					hostname: "cap.so",
					is_session_entry: true,
					first_touch_campaign: campaign,
				}),
			).toBeNull();
		}
		expect(
			normalizeProductEventProperties("tool_interaction", {
				tool: "trimmer",
				action: "process_failed",
				failure_class: "Network request failed for customer Alice",
			}),
		).toBeNull();
	});

	it("preserves bounded campaign labels and advertising click identifiers", () => {
		expect(
			normalizeProductEventProperties("page_view", {
				hostname: "WWW.Cap.SO",
				is_session_entry: true,
				first_touch_campaign: "Summer launch 2026",
				first_touch_gclid: "EAIaIQobChMI-safe_click_123",
			}),
		).toMatchObject({
			hostname: "www.cap.so",
			first_touch_campaign: "Summer launch 2026",
			first_touch_gclid: "EAIaIQobChMI-safe_click_123",
		});
	});

	it("returns undefined for an event whose schema has no properties", () => {
		expect(normalizeProductEventProperties("user_signed_up")).toBeUndefined();
	});

	it("rejects customer content aliases", () => {
		expect(
			normalizeProductEventProperties("recording_completed", {
				transcript: "private",
			}),
		).toBeNull();
	});
});

describe("normalizeProductEventInput", () => {
	const now = Date.parse("2026-07-12T12:00:00.000Z");
	const baseEvent = {
		eventId: "event-1",
		eventName: "export_button_clicked",
		occurredAt: "2026-07-12T11:59:59.000Z",
		anonymousId: "anonymous-1",
		sessionId: "session-1",
		platform: "desktop",
	};

	it("normalizes a valid event", () => {
		expect(normalizeProductEventInput(baseEvent, now)).toEqual(baseEvent);
	});

	it.each([
		["unknown event", { ...baseEvent, eventName: "mouse_moved" }],
		["missing id", { ...baseEvent, eventId: "" }],
		["unknown platform", { ...baseEvent, platform: "mobile" }],
		["server-authored platform", { ...baseEvent, platform: "server" }],
		["invalid timestamp", { ...baseEvent, occurredAt: "not-a-date" }],
		[
			"stale timestamp",
			{ ...baseEvent, occurredAt: "2026-07-01T11:59:59.000Z" },
		],
		[
			"future timestamp",
			{ ...baseEvent, occurredAt: "2026-07-12T12:06:00.000Z" },
		],
	])("rejects %s", (_label, event) => {
		expect(normalizeProductEventInput(event, now)).toBeNull();
	});

	it("truncates bounded context", () => {
		const normalized = normalizeProductEventInput(
			{
				...baseEvent,
				pathname: `/${"short/".repeat(PRODUCT_ANALYTICS_LIMITS.pathnameLength)}`,
			},
			now,
		);
		expect(normalized?.pathname).toHaveLength(
			PRODUCT_ANALYTICS_LIMITS.pathnameLength,
		);
		expect(normalized?.properties).toBeUndefined();
	});

	it("rejects an invalid property payload as a whole", () => {
		expect(
			normalizeProductEventInput(
				{ ...baseEvent, properties: { content: "private" } },
				now,
			),
		).toBeNull();
	});

	it("removes query strings and high-cardinality path segments", () => {
		const normalized = normalizeProductEventInput(
			{
				...baseEvent,
				pathname:
					"https://cap.so/s/019f1ad7-2deb-7730-8d27-916abc9cd4d8?token=private",
			},
			now,
		);
		expect(normalized?.pathname).toBe("/s/:id");
	});

	it.each([
		"/customer/alice@example.com",
		"/customer/alice%40example.com",
		"/customer/0123456789abcdef0123456789abcdef",
		"/customer/user0123456789abcdef012345",
	])("redacts sensitive path segment in %s", (pathname) => {
		expect(
			normalizeProductEventInput({ ...baseEvent, pathname }, now)?.pathname,
		).toBe("/customer/:id");
	});

	it("rejects identifiers that contain personal data or unsafe syntax", () => {
		expect(
			normalizeProductEventInput(
				{ ...baseEvent, anonymousId: "alice@example.com" },
				now,
			),
		).toBeNull();
		expect(
			normalizeProductEventInput(
				{ ...baseEvent, eventId: "event/customer/file.mp4" },
				now,
			),
		).toBeNull();
	});

	it.each([
		"/screen-recorder-windows",
		"/loom-alternative",
		"/blog/how-to-record-your-screen-with-audio",
	])("preserves static acquisition route %s", (pathname) => {
		expect(
			normalizeProductEventInput({ ...baseEvent, pathname }, now)?.pathname,
		).toBe(pathname);
	});

	it("normalizes Cap IDs only on dynamic route segments", () => {
		expect(
			normalizeProductEventInput(
				{ ...baseEvent, pathname: "/dashboard/spaces/01abcdefghjkmnp" },
				now,
			)?.pathname,
		).toBe("/dashboard/spaces/:id");
	});

	it("keeps only the referrer hostname", () => {
		const normalized = normalizeProductEventInput(
			{
				...baseEvent,
				referrer: "https://www.google.com/search?q=private",
			},
			now,
		);
		expect(normalized?.referrer).toBe("www.google.com");
	});
});

describe("createProductEventRows", () => {
	it("fingerprints canonical payloads independent of object key order", () => {
		expect(createProductEventPayloadHash({ a: 1, b: 2 })).toBe(
			createProductEventPayloadHash({ b: 2, a: 1 }),
		);
		expect(createProductEventPayloadHash({ a: 1, b: 2 })).not.toBe(
			createProductEventPayloadHash({ a: 1, b: 3 }),
		);
	});

	it("adds trusted server context without accepting client identity", () => {
		const [row] = createProductEventRows(
			[
				{
					eventId: "event-1",
					eventName: "purchase_completed",
					occurredAt: "2026-07-12T12:00:00.000Z",
					anonymousId: "guest-checkout",
					platform: "server",
					properties: {
						payment_status: "paid",
						subscription_status: "active",
						is_first_purchase: true,
						is_guest_checkout: true,
						is_onboarding: false,
					},
				},
			],
			{
				receivedAt: "2026-07-12T12:00:01.000Z",
				source: "server",
				userId: "user-1",
				organizationId: "org-1",
				country: "CY",
			},
		);

		expect(row).toMatchObject({
			event_id: "event-1",
			payload_hash: expect.stringMatching(/^[0-9a-f]{32}$/),
			event_name: "purchase_completed",
			source: "server",
			user_id: "user-1",
			organization_id: "org-1",
			country: "CY",
			properties:
				'{"payment_status":"paid","subscription_status":"active","is_first_purchase":true,"is_guest_checkout":true,"is_onboarding":false}',
		});
	});
});
