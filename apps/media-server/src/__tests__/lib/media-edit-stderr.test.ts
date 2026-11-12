import { describe, expect, test } from "bun:test";
import { readStreamTail, STDERR_TAIL_BYTES } from "../../lib/media-edit";

const encoder = new TextEncoder();

function streamOf(chunks: Iterable<Uint8Array>) {
	const iterator = chunks[Symbol.iterator]();
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			const next = iterator.next();
			if (next.done) controller.close();
			else controller.enqueue(next.value);
		},
	});
}

function* lines(count: number) {
	for (let index = 0; index < count; index += 1) {
		yield encoder.encode(`[h264 @ 0x1] error while decoding MB ${index}\n`);
	}
}

describe("readStreamTail", () => {
	test("returns short output whole", async () => {
		const text = await readStreamTail(
			streamOf([encoder.encode("frame=1\n"), encoder.encode("done\n")]),
		);
		expect(text).toBe("frame=1\ndone\n");
	});

	test("returns an empty string when there is no stream", async () => {
		expect(await readStreamTail(null)).toBe("");
	});

	test("keeps only the end of a long output and reads it all", async () => {
		const count = 400_000;
		let seen = 0;
		const text = await readStreamTail(streamOf(lines(count)), (part) => {
			seen += part.length;
		});
		expect(encoder.encode(text).length).toBeLessThanOrEqual(STDERR_TAIL_BYTES);
		expect(text.length).toBeGreaterThan(STDERR_TAIL_BYTES / 2);
		expect(text.endsWith(`error while decoding MB ${count - 1}\n`)).toBe(true);
		expect(seen).toBeGreaterThan(count * 30);
	});

	test("keeps the end of a single chunk larger than the limit", async () => {
		const text = await readStreamTail(
			streamOf([encoder.encode(`${"a".repeat(5000)}END`)]),
			undefined,
			100,
		);
		expect(text).toBe(`${"a".repeat(97)}END`);
	});

	test("keeps exactly the last bytes across many small chunks", async () => {
		const parts = Array.from({ length: 50 }, (_, index) =>
			encoder.encode(String(index % 10)),
		);
		const text = await readStreamTail(streamOf(parts), undefined, 7);
		expect(text).toBe("3456789");
	});

	test("passes every chunk to the listener even past the limit", async () => {
		const heard: string[] = [];
		await readStreamTail(
			streamOf([
				encoder.encode("one "),
				encoder.encode("two "),
				encoder.encode("three"),
			]),
			(part) => heard.push(part),
			4,
		);
		expect(heard.join("")).toBe("one two three");
	});
});
