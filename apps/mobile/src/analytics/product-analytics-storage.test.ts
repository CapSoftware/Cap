import { describe, expect, it, vi } from "vitest";
import type { MobileProductAnalyticsState } from "./product-analytics-client";
import { createMobileProductAnalyticsStorage } from "./product-analytics-storage";

const state = (attempted: number) =>
	({
		version: 2,
		anonymousIds: {},
		pending: [],
		deadLetters: [],
		deadLetterEvicted: 0,
		eventLedger: [],
		delivery: {
			attempted,
			accepted: 0,
			retried: 0,
			dropped: 0,
			queue_overflow: 0,
			oversize: 0,
			contract_rejected: 0,
			persistence_failed: 0,
		},
	}) satisfies MobileProductAnalyticsState;

const createHarness = () => {
	const files = new Map<string, string>();
	let failFinalMove = false;
	const fileSystem = {
		writeAsStringAsync: vi.fn(async (uri: string, contents: string) => {
			files.set(uri, contents);
		}),
		readAsStringAsync: vi.fn(async (uri: string) => {
			const contents = files.get(uri);
			if (contents === undefined) throw new Error("missing");
			return contents;
		}),
		deleteAsync: vi.fn(async (uri: string) => {
			files.delete(uri);
		}),
		getInfoAsync: vi.fn(async (uri: string) => ({ exists: files.has(uri) })),
		moveAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => {
			if (failFinalMove && from.endsWith(".next")) throw new Error("interrupted");
			const contents = files.get(from);
			if (contents === undefined) throw new Error("missing");
			files.set(to, contents);
			files.delete(from);
		}),
	};
	return {
		files,
		storage: createMobileProductAnalyticsStorage(fileSystem, "file:///docs/"),
		failFinalMove: () => {
			failFinalMove = true;
		},
	};
};

describe("mobile product analytics storage", () => {
	it("recovers the last valid state after an interrupted rotation", async () => {
		const harness = createHarness();
		await harness.storage.writeState(state(1));
		harness.failFinalMove();
		await expect(harness.storage.writeState(state(2))).rejects.toThrow(
			"interrupted",
		);
		expect(await harness.storage.readState()).toEqual(state(1));
	});

	it("falls back from corrupt current state to a valid backup", async () => {
		const harness = createHarness();
		harness.files.set(
			"file:///docs/product-analytics-outbox-v1.json",
			"invalid",
		);
		harness.files.set(
			"file:///docs/product-analytics-outbox-v1.json.backup",
			JSON.stringify(state(3)),
		);
		expect(await harness.storage.readState()).toEqual(state(3));
	});
});
