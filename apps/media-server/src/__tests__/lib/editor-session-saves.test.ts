import { expect, test } from "bun:test";
import { closeAfter, settlePendingCloses } from "../../lib/editor-sessions";

test("a session closing after its Save closes whether the Save published or failed", async () => {
	const closed: string[] = [];
	await closeAfter(Promise.resolve(), async () => {
		closed.push("published");
	});
	await closeAfter(Promise.reject(new Error("upload failed")), async () => {
		closed.push("failed");
	});
	expect(closed).toEqual(["published", "failed"]);
	expect(await settlePendingCloses(10)).toBe(true);
});

test("shutdown waits for a Save still publishing, up to its limit", async () => {
	let publish: () => void = () => {};
	const save = new Promise<void>((resolve) => {
		publish = resolve;
	});
	let closed = false;
	void closeAfter(save, async () => {
		closed = true;
	});
	expect(await settlePendingCloses(20)).toBe(false);
	expect(closed).toBe(false);
	setTimeout(publish, 10);
	expect(await settlePendingCloses(1_000)).toBe(true);
	expect(closed).toBe(true);
});
