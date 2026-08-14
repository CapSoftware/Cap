import { describe, expect, it } from "vitest";

import {
	type VisibilityDocument,
	waitUntilVisible,
} from "./update-check-visibility";

class FakeVisibilityDocument implements VisibilityDocument {
	hidden = true;
	readonly listeners = new Set<() => void>();

	addEventListener(_type: "visibilitychange", listener: () => void) {
		this.listeners.add(listener);
	}

	removeEventListener(_type: "visibilitychange", listener: () => void) {
		this.listeners.delete(listener);
	}

	show() {
		this.hidden = false;
		for (const listener of [...this.listeners]) listener();
	}
}

describe("waitUntilVisible", () => {
	it("resolves immediately for a visible document", async () => {
		const document = new FakeVisibilityDocument();
		document.hidden = false;

		await expect(waitUntilVisible(document)).resolves.toBe(true);
		expect(document.listeners).toHaveLength(0);
	});

	it("waits for a hidden document to become visible", async () => {
		const document = new FakeVisibilityDocument();
		const result = waitUntilVisible(document);

		expect(document.listeners).toHaveLength(1);
		document.show();

		await expect(result).resolves.toBe(true);
		expect(document.listeners).toHaveLength(0);
	});

	it("cleans up and declines the check when aborted", async () => {
		const document = new FakeVisibilityDocument();
		const controller = new AbortController();
		const result = waitUntilVisible(document, controller.signal);

		controller.abort();

		await expect(result).resolves.toBe(false);
		expect(document.listeners).toHaveLength(0);
	});
});
