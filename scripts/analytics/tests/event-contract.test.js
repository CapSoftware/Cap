import assert from "node:assert/strict";
import test from "node:test";

import {
	analyzeRustNativeContract,
	analyzeTypeScriptSource,
	findMissingEmitters,
	parseEventRegistry,
	rustProductionVariantUses,
	tokenizeRust,
} from "../check-event-contract.js";

const registrySource = `
export const EVENT_REGISTRY = {
	page_view: { platforms: ["web"], properties: {} },
	page_engagement: { platforms: ["web"], properties: {} },
	tool_interaction: { platforms: ["web"], properties: {} },
	purchase_completed: { platforms: ["web", "server"], properties: {} },
	recording_started: { platforms: ["desktop", "mobile"], properties: {} },
} as const satisfies Record<string, unknown>;
`;

const registry = parseEventRegistry(registrySource, "event-registry.ts");
const registeredEvents = new Set(registry.events.keys());

test("parses EVENT_REGISTRY with TypeScript syntax", () => {
	assert.deepEqual(
		[...registry.events.keys()],
		[
			"page_view",
			"page_engagement",
			"tool_interaction",
			"purchase_completed",
			"recording_started",
		],
	);
	assert.deepEqual(registry.diagnostics, []);
	assert.deepEqual(registry.events.get("recording_started")?.platforms, [
		"desktop",
		"mobile",
	]);
});

test("rejects missing or dynamic registry platform declarations", () => {
	const parsed = parseEventRegistry(
		`export const EVENT_REGISTRY = {
			missing: { properties: {} },
			dynamic: { platforms: supportedPlatforms, properties: {} },
		} as const;`,
		"event-registry.ts",
	);
	assert.deepEqual(
		parsed.diagnostics.map((entry) => entry.code),
		["registry-platforms-not-static", "registry-platforms-not-static"],
	);
});

test("requires bounded formats for every string property", () => {
	const parsed = parseEventRegistry(
		`export const EVENT_REGISTRY = {
			unsafe: { platforms: ["web"], properties: { error: { type: "string" } } },
			safeEnum: { platforms: ["web"], properties: { mode: { type: "string", values: ["one"] } } },
			safeCategory: { platforms: ["web"], properties: { mode: { type: "string", format: "category" } } },
		} as const;`,
		"event-registry.ts",
	);
	assert.deepEqual(
		parsed.diagnostics.map((entry) => entry.code),
		["unbounded-string-property"],
	);
});

test("finds imported capture calls without matching comments or unrelated functions", () => {
	const result = analyzeTypeScriptSource({
		file: "caller.tsx",
		registeredEvents,
		sourceText: `
import { trackEvent as capture } from "@/app/utils/analytics";
import { trackEvent } from "unrelated";
// capture("not_real");
capture("page_view");
trackEvent("not_analytics");
`,
	});
	assert.deepEqual(
		result.emissions.map(({ eventName, platforms }) => ({
			eventName,
			platforms,
		})),
		[{ eventName: "page_view", platforms: [] }],
	);
	assert.deepEqual(result.diagnostics, []);
});

test("resolves relative imports to analytics wrappers", () => {
	const web = analyzeTypeScriptSource({
		file: "apps/web/app/Layout/Page.tsx",
		registeredEvents,
		sourceText: `
import { captureProductPageView } from "../utils/product-analytics";
captureProductPageView();
`,
	});
	const desktop = analyzeTypeScriptSource({
		file: "apps/desktop/src/utils/auth.ts",
		registeredEvents: new Set([...registeredEvents, "user_signed_in"]),
		sourceText: `
import { trackEvent } from "./analytics";
trackEvent("user_signed_in");
`,
	});
	assert.deepEqual(
		[...web.emissions, ...desktop.emissions].map(
			({ eventName, platforms }) => ({ eventName, platforms }),
		),
		[
			{ eventName: "page_view", platforms: ["web"] },
			{ eventName: "user_signed_in", platforms: ["desktop"] },
		],
	);
	assert.deepEqual([...web.diagnostics, ...desktop.diagnostics], []);
});

test("infers mobile emitters from the typed mobile wrapper path", () => {
	const result = analyzeTypeScriptSource({
		file: "apps/mobile/src/auth/AuthContext.tsx",
		registeredEvents: new Set([...registeredEvents, "user_signed_in"]),
		sourceText: `
			import { trackMobileProductEvent } from "@/analytics/product-analytics";
			trackMobileProductEvent("user_signed_in");
		`,
	});
	assert.deepEqual(
		result.emissions.map(({ eventName, platforms }) => ({
			eventName,
			platforms,
		})),
		[{ eventName: "user_signed_in", platforms: ["mobile"] }],
	);
	assert.deepEqual(result.diagnostics, []);
});

test("reads deterministic mobile event names from the typed argument", () => {
	const result = analyzeTypeScriptSource({
		file: "apps/mobile/src/uploads/runMobileUpload.ts",
		registeredEvents: new Set([
			...registeredEvents,
			"multipart_upload_complete",
		]),
		sourceText: `
			import { trackMobileProductEventWithId } from "@/analytics/product-analytics";
			trackMobileProductEventWithId("event-1", "2026-07-31T12:00:00Z", "multipart_upload_complete", {});
		`,
	});
	assert.deepEqual(
		result.emissions.map(({ eventName, platforms }) => ({
			eventName,
			platforms,
		})),
		[{ eventName: "multipart_upload_complete", platforms: ["mobile"] }],
	);
	assert.deepEqual(result.diagnostics, []);
});

test("rejects unregistered strings and dynamic templates", () => {
	const result = analyzeTypeScriptSource({
		file: "caller.ts",
		registeredEvents,
		sourceText: `
import { trackEvent } from "@/app/utils/analytics";
trackEvent("unknown_event");
trackEvent(\`tool_\${action}\`);
`,
	});
	assert.deepEqual(
		result.diagnostics.map((entry) => entry.code),
		["unregistered-event", "dynamic-event-template"],
	);
});

test("finds inline server event objects and helper-backed emitters", () => {
	const server = analyzeTypeScriptSource({
		file: "apps/web/app/api/webhooks/route.ts",
		registeredEvents,
		sourceText: `
import { queueServerProductEvent as queue } from "@/lib/analytics/server";
queue({ eventId: "evt", eventName: "purchase_completed", platform: "server" });
`,
	});
	const browser = analyzeTypeScriptSource({
		file: "browser.tsx",
		registeredEvents,
		sourceText: `
import {
	captureProductPageEngagement,
	captureProductPageView,
} from "@/app/utils/product-analytics";
import { trackToolInteraction } from "@/app/utils/analytics";
captureProductPageView();
captureProductPageEngagement("/", 100, 0.5);
trackToolInteraction({ tool: "trimmer", action: "loaded" });
`,
	});
	assert.deepEqual(
		[...server.emissions, ...browser.emissions].map(
			({ eventName, platforms }) => ({ eventName, platforms }),
		),
		[
			{ eventName: "purchase_completed", platforms: ["server"] },
			{ eventName: "page_view", platforms: [] },
			{ eventName: "page_engagement", platforms: [] },
			{ eventName: "tool_interaction", platforms: [] },
		],
	);
	assert.deepEqual([...server.diagnostics, ...browser.diagnostics], []);
});

test("does not infer a platform from the file when an inline platform is dynamic", () => {
	const result = analyzeTypeScriptSource({
		file: "apps/web/app/api/checkout/route.ts",
		registeredEvents,
		sourceText: `
			import { queueServerProductEvent } from "@/lib/analytics/server";
			queueServerProductEvent({
				eventId: "evt",
				eventName: "purchase_completed",
				platform: checkoutPlatform,
			});
		`,
	});
	assert.deepEqual(result.emissions[0]?.platforms, []);
});

test("accepts registered typed business-event factories", () => {
	const result = analyzeTypeScriptSource({
		sourceText: `
			import { userSignedUpEvent } from "@/lib/analytics/business-events";
			import { queueServerProductEvent } from "@/lib/analytics/server";
			queueServerProductEvent(userSignedUpEvent({ userId: "user-1", createdAt: new Date() }));
		`,
		file: "apps/web/actions/signup.ts",
		registeredEvents: new Set(["user_signed_up"]),
	});
	assert.deepEqual(result.diagnostics, []);
	assert.ok(
		result.emissions.every(
			(emission) =>
				emission.eventName === "user_signed_up" &&
				emission.platforms.includes("web"),
		),
	);
});

test("credits only the literal platform passed to routed business factories", () => {
	const literal = analyzeTypeScriptSource({
		sourceText: `
			import { shareLinkCreatedEvent } from "@/lib/analytics/business-events";
			shareLinkCreatedEvent({ platform: "mobile" });
		`,
		file: "apps/web/app/api/mobile/share.ts",
		registeredEvents: new Set(["share_link_created"]),
	});
	const dynamic = analyzeTypeScriptSource({
		sourceText: `
			import { shareLinkCreatedEvent } from "@/lib/analytics/business-events";
			shareLinkCreatedEvent({ platform });
		`,
		file: "apps/web/workflows/reconcile.ts",
		registeredEvents: new Set(["share_link_created"]),
	});
	const bounded = analyzeTypeScriptSource({
		sourceText: `
			import { checkoutStartedEvent } from "@/lib/analytics/business-events";
			const checkoutPlatform = platform === "mobile" ? "mobile" : "desktop";
			checkoutStartedEvent({ platform: checkoutPlatform });
		`,
		file: "apps/web/app/api/desktop/subscribe.ts",
		registeredEvents: new Set(["checkout_started"]),
	});
	assert.deepEqual(literal.emissions[0]?.platforms, ["mobile"]);
	assert.deepEqual(dynamic.emissions[0]?.platforms, []);
	assert.deepEqual(bounded.emissions[0]?.platforms, ["mobile", "desktop"]);
});

test("accepts a bounded helper that emits one of a declared event set", () => {
	const result = analyzeTypeScriptSource({
		sourceText: `
			import { queueSubscriptionCheckoutProductEvent } from "@/lib/analytics/stripe-business-events";
			queueSubscriptionCheckoutProductEvent({ eventId: "evt_1" });
		`,
		file: "apps/web/app/api/webhooks/stripe/route.ts",
		registeredEvents: new Set(["purchase_completed", "trial_started"]),
	});
	assert.deepEqual(result.diagnostics, []);
	assert.deepEqual(
		result.emissions.map(({ eventName, platforms }) => ({
			eventName,
			platforms,
		})),
		[
			{
				eventName: "purchase_completed",
				platforms: ["web", "desktop", "mobile", "cli", "server"],
			},
			{
				eventName: "trial_started",
				platforms: ["web", "desktop", "mobile", "cli", "server"],
			},
		],
	);
});

test("Rust tokenization excludes comments", () => {
	const tokens = tokenizeRust(`
// EventData::new("comment_event")
/* ProductAnalyticsEvent::Commented */
EventData::new("recording_started")
`);
	assert.deepEqual(
		tokens
			.filter((token) => token.type === "string")
			.map((token) => token.value),
		["recording_started"],
	);
});

test("native emitter discovery excludes cfg test items", () => {
	const variants = rustProductionVariantUses(`
#[cfg(test)]
mod tests {
	fn emits_only_in_tests() {
		ProductAnalyticsEvent::RecordingCompleted;
	}
}

fn production() {
	ProductAnalyticsEvent::RecordingStarted;
}
`);
	assert.deepEqual([...variants], ["RecordingStarted"]);
});

test("native Rust mappings match variants, registry and core catalog", () => {
	const result = analyzeRustNativeContract({
		file: "product_analytics.rs",
		registeredEvents,
		sourceText: `
enum ProductAnalyticsEvent { RecordingStarted { enabled: bool } }
fn event_data(event: ProductAnalyticsEvent) -> EventData {
	match event {
		ProductAnalyticsEvent::RecordingStarted { enabled } => {
			EventData::new("recording_started")
		}
	}
}
fn is_core_product_event(name: &str) -> bool {
	matches!(name, "recording_started")
}
`,
	});
	assert.deepEqual(result.diagnostics, []);
	assert.equal(
		result.mappings.get("RecordingStarted")?.eventName,
		"recording_started",
	);
});

test("native Rust divergence is rejected", () => {
	const result = analyzeRustNativeContract({
		file: "product_analytics.rs",
		registeredEvents,
		sourceText: `
fn event_data(event: ProductAnalyticsEvent) -> EventData {
	match event {
		ProductAnalyticsEvent::RecordingStarted => {
			EventData::new("page_view")
		}
	}
}
fn is_core_product_event(name: &str) -> bool {
	matches!(name, "page_engagement")
}
`,
	});
	assert.deepEqual(result.diagnostics.map((entry) => entry.code).sort(), [
		"native-core-catalog-extra",
		"native-core-catalog-missing",
		"native-event-name-diverged",
	]);
});

test("registry entries without production emitters fail", () => {
	const diagnostics = findMissingEmitters(registry.events, [
		{ eventName: "page_view", platforms: ["web"] },
		{ eventName: "page_engagement", platforms: ["web"] },
		{ eventName: "tool_interaction", platforms: ["web"] },
		{ eventName: "purchase_completed", platforms: ["web", "server"] },
	]);
	assert.deepEqual(
		diagnostics.map((entry) => entry.message),
		[
			"Registry event recording_started has no production emitter",
			"Registry event recording_started declares platform desktop without a production emitter",
			"Registry event recording_started declares platform mobile without a production emitter",
		],
	);
});

test("fails each declared platform without a matching production emitter", () => {
	const diagnostics = findMissingEmitters(registry.events, [
		{ eventName: "recording_started", platforms: ["desktop"] },
	]);
	assert.deepEqual(
		diagnostics
			.filter(
				(entry) =>
					entry.code === "registry-event-platform-without-emitter" &&
					entry.message.includes("recording_started"),
			)
			.map((entry) => entry.message),
		[
			"Registry event recording_started declares platform mobile without a production emitter",
		],
	);
});
