import { describe, expect, test } from "bun:test";
import { withIdleTimeout } from "../../lib/media-common";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("withIdleTimeout", () => {
	test("lets slow work finish for as long as it keeps reporting progress", async () => {
		const result = await withIdleTimeout(async (touch) => {
			for (let step = 0; step < 8; step++) {
				await wait(30);
				touch();
			}
			return "done";
		}, 80);
		expect(result).toBe("done");
	});

	test("stops work that goes quiet and runs its cleanup", async () => {
		let cleaned = false;
		const started = performance.now();
		await expect(
			withIdleTimeout(
				async (touch) => {
					touch();
					await wait(1_000);
					return "late";
				},
				60,
				() => {
					cleaned = true;
				},
			),
		).rejects.toThrow("Stopped making progress");
		expect(performance.now() - started).toBeLessThan(500);
		expect(cleaned).toBe(true);
	});
});
