import { describe, expect, test } from "bun:test";
import {
	type PreverifiedRunPayload,
	readBoundedText,
	readPreverifiedRun,
	resolvePreverifiedRuns,
	signPreverifiedRun,
} from "../../lib/recording-preverify";

const init = { objectIdentity: '"init"', size: 800 };
const segment = (index: number) => ({
	objectIdentity: `"segment-${index}"`,
	size: 1000 + index,
});
const segments = Array.from({ length: 8 }, (_, index) => segment(index + 1));
const run = (from: number, to: number, label = ""): PreverifiedRunPayload => ({
	version: 1,
	init,
	segments: segments.slice(from, to),
	lines: [`#tb 0: 1/30${label}`, `0, 0, 0, 1, 100, 0x0000000${from}`],
});

describe("signed preverified runs", () => {
	test("round-trips a run signed with the same secret", () => {
		const payload = run(0, 3);
		expect(
			readPreverifiedRun(signPreverifiedRun(payload, "secret"), "secret"),
		).toEqual(payload);
	});

	test.each([
		["another secret", (text: string) => text, "other"],
		[
			"a changed line",
			(text: string) => text.replace("0x00000000", "0x00000001"),
			"secret",
		],
		[
			"a changed fragment identity",
			(text: string) => text.replace('\\"segment-1\\"', '\\"segment-9\\"'),
			"secret",
		],
		[
			"a removed signature",
			(text: string) =>
				JSON.stringify({ ...JSON.parse(text), signature: undefined }),
			"secret",
		],
		["invalid JSON", () => "{", "secret"],
	])("rejects %s", (_, tamper, secret) => {
		expect(
			readPreverifiedRun(
				tamper(signPreverifiedRun(run(0, 3), "secret")),
				secret,
			),
		).toBeNull();
	});
});

describe("chaining preverified runs", () => {
	test("chains runs that cover fragments from the start in order", () => {
		const resolved = resolvePreverifiedRuns(
			[run(3, 6), run(0, 3)],
			init,
			segments,
		);
		expect(resolved.map((entry) => entry.segments)).toEqual([3, 3]);
	});

	test("stops at the first fragment no run starts at", () => {
		expect(
			resolvePreverifiedRuns([run(0, 2), run(3, 5)], init, segments).map(
				(entry) => entry.segments,
			),
		).toEqual([2]);
	});

	test("prefers the longest run starting at a fragment", () => {
		expect(
			resolvePreverifiedRuns(
				[run(0, 2), run(0, 4, "-long")],
				init,
				segments,
			).map((entry) => entry.segments),
		).toEqual([4]);
	});

	test("ignores runs over another recording's init or different fragment bytes", () => {
		expect(
			resolvePreverifiedRuns(
				[{ ...run(0, 3), init: { ...init, objectIdentity: '"other"' } }],
				init,
				segments,
			),
		).toEqual([]);
		expect(
			resolvePreverifiedRuns(
				[run(0, 3)],
				init,
				segments.map((entry, index) =>
					index === 1 ? { ...entry, size: entry.size + 1 } : entry,
				),
			),
		).toEqual([]);
	});

	test("ignores a run longer than the recording", () => {
		expect(
			resolvePreverifiedRuns([run(0, 8)], init, segments.slice(0, 5)),
		).toEqual([]);
	});
});

describe("bounded run reads", () => {
	const stream = (sizes: number[]) =>
		new Response(
			new ReadableStream({
				start(controller) {
					for (const size of sizes)
						controller.enqueue(new Uint8Array(size).fill(97));
					controller.close();
				},
			}),
		);

	test("reads a body within the limit", async () => {
		expect(await readBoundedText(stream([3, 4]), 7)).toBe("aaaaaaa");
	});

	test("stops at the limit even without a Content-Length", async () => {
		const response = stream([4, 4, 4]);
		expect(response.headers.get("content-length")).toBeNull();
		expect(await readBoundedText(response, 7)).toBeNull();
	});
});
