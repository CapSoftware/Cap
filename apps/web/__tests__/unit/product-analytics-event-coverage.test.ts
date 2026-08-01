import {
	EVENT_REGISTRY,
	normalizeProductEventInput,
	type ProductEventPlatform,
} from "@cap/analytics";
import { describe, expect, it } from "vitest";
import {
	createServerProductEventRows,
	type ServerProductEvent,
} from "@/lib/analytics/server-event";

const occurredAt = "2026-07-31T12:00:00.000Z";

function runtimeProperties(
	properties: Record<
		string,
		{
			type: "boolean" | "number" | "string";
			values?: readonly string[];
			format?: string;
		}
	>,
) {
	return Object.fromEntries(
		Object.entries(properties).map(([key, rule]) => {
			if (rule.type === "boolean") return [key, true];
			if (rule.type === "number") return [key, 1];
			if (rule.values) return [key, rule.values[0]];
			if (rule.format === "hostname") return [key, "cap.so"];
			if (rule.format === "timestamp") return [key, occurredAt];
			return [key, "bounded_value"];
		}),
	);
}

describe("product analytics runtime emitter coverage", () => {
	it("executes every declared event and platform through an authorized emitter", () => {
		const covered = new Set<string>();
		for (const [eventName, definition] of Object.entries(EVENT_REGISTRY)) {
			const properties = runtimeProperties(definition.properties);
			for (const platform of definition.platforms) {
				const key = `${eventName}:${platform}`;
				if (definition.authority !== "server" && platform !== "server") {
					const event = normalizeProductEventInput({
						eventId: `client:${key}`,
						eventName,
						occurredAt,
						anonymousId: "anonymous-coverage",
						sessionId: "session-coverage",
						platform,
						...(Object.keys(properties).length > 0 ? { properties } : {}),
					});
					expect(event, key).not.toBeNull();
					covered.add(key);
				}
				if (definition.authority !== "client") {
					const rows = createServerProductEventRows({
						eventId: `server:${key}`,
						eventName,
						occurredAt,
						anonymousId: "anonymous-coverage",
						platform: platform as ProductEventPlatform,
						userId: "user-coverage",
						organizationId: "organization-coverage",
						...(Object.keys(properties).length > 0 ? { properties } : {}),
					} as ServerProductEvent);
					expect(rows, key).toHaveLength(1);
					covered.add(key);
				}
			}
		}

		const declared = Object.entries(EVENT_REGISTRY).flatMap(
			([eventName, definition]) =>
				definition.platforms.map((platform) => `${eventName}:${platform}`),
		);
		expect([...covered].sort()).toEqual(declared.sort());
	});
});
