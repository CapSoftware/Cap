import { describe, expect, test } from "bun:test";
import { cursorProgress } from "./cursor";

describe("cursorProgress", () => {
	test("weights tracking and repair into one job-wide value", () => {
		expect(cursorProgress('{"stage":"tracking","progress":0.5}')).toBe(350);
		expect(cursorProgress('{"stage":"tracking","progress":1}')).toBe(700);
		expect(cursorProgress('{"stage":"repairing","progress":0.5}')).toBe(845);
		expect(cursorProgress('{"stage":"complete","progress":1}')).toBe(990);
		expect(cursorProgress('{"stage":"tracking","progress":7}')).toBe(700);
	});

	test("ignores lines that are not progress reports", () => {
		expect(cursorProgress("Error: Unsupported video")).toBeNull();
		expect(cursorProgress('{"stage":"rendering","progress":0}')).toBeNull();
		expect(cursorProgress('{"stage":"tracking"}')).toBeNull();
	});
});
