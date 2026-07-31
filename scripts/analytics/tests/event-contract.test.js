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
	page_view: { properties: {} },
	page_engagement: { properties: {} },
	tool_interaction: { properties: {} },
	purchase_completed: { properties: {} },
	recording_started: { properties: {} },
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
		result.emissions.map((emission) => emission.eventName),
		["page_view"],
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
			(emission) => emission.eventName,
		),
		["page_view", "user_signed_in"],
	);
	assert.deepEqual([...web.diagnostics, ...desktop.diagnostics], []);
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
		file: "server.ts",
		registeredEvents,
		sourceText: `
import { queueServerProductEvent as queue } from "@/lib/analytics/server";
queue({ eventId: "evt", eventName: "purchase_completed" });
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
			(emission) => emission.eventName,
		),
		["purchase_completed", "page_view", "page_engagement", "tool_interaction"],
	);
	assert.deepEqual([...server.diagnostics, ...browser.diagnostics], []);
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
			(emission) => emission.eventName === "user_signed_up",
		),
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
		{ eventName: "page_view" },
		{ eventName: "page_engagement" },
		{ eventName: "tool_interaction" },
		{ eventName: "purchase_completed" },
	]);
	assert.deepEqual(
		diagnostics.map((entry) => entry.message),
		["Registry event recording_started has no production emitter"],
	);
});
