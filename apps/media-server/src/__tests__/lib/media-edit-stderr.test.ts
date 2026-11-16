import { describe, expect, test } from "bun:test";
import {
	lineReader,
	readStreamTail,
	STDERR_TAIL_BYTES,
} from "../../lib/media-edit";

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

	test("keeps the last bytes when two chunks together pass the limit", async () => {
		const first = encoder.encode("a".repeat(100));
		const second = encoder.encode("b".repeat(99));
		const text = await readStreamTail(
			streamOf([first, second]),
			undefined,
			100,
		);
		expect(text).toBe(`a${"b".repeat(99)}`);
	});
});

describe("lineReader", () => {
	test("joins lines that arrive in pieces and ends the last one", () => {
		const seen: string[] = [];
		const lines = lineReader((line) => seen.push(line));
		lines.push("Error opening ");
		lines.push("input\nframe=1\r\nlast");
		expect(seen).toEqual(["Error opening input", "frame=1"]);
		lines.end();
		expect(seen).toEqual(["Error opening input", "frame=1", "last"]);
	});

	test("an early error line survives far more output than is kept", async () => {
		const seen: string[] = [];
		const lines = lineReader((line) => {
			if (line.includes("Error")) seen.push(line);
		});
		function* output() {
			yield encoder.encode("Error while opening encoder\n");
			for (let index = 0; index < 20_000; index += 1) {
				yield encoder.encode(`frame=${index} fps=30 bitrate=1000kbits/s\n`);
			}
		}
		const text = await readStreamTail(streamOf(output()), lines.push);
		lines.end();
		expect(text.includes("Error while opening encoder")).toBe(false);
		expect(seen).toEqual(["Error while opening encoder"]);
	});

	test("cuts off a line that never ends", () => {
		const seen: string[] = [];
		const lines = lineReader((line) => seen.push(line));
		for (let index = 0; index < 100; index += 1) lines.push("x".repeat(1000));
		lines.end();
		expect(seen).toHaveLength(1);
		expect(seen[0]?.length).toBeLessThanOrEqual(4096);
	});
});
