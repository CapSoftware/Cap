import { describe, expect, it } from "vitest";
import { isFolderSort, sortFolders } from "@/lib/folder-sort";

const folder = (id: string, name: string, createdAt: string) => ({
	id,
	name,
	createdAt: new Date(createdAt),
});

// The exact shape from the customer report: numbered folders that came back
// in primary-key order because nothing sorted them.
const numbered = [
	folder("k", "14_Account & Permissions", "2026-08-01T00:00:14Z"),
	folder("a", "23_Support & Contact", "2026-08-01T00:00:23Z"),
	folder("q", "7_Hot/Warm Leads", "2026-08-01T00:00:07Z"),
	folder("m", "1_Getting Started", "2026-08-01T00:00:01Z"),
	folder("c", "2_Command Center", "2026-08-01T00:00:02Z"),
	folder("z", "10_Team Conversations", "2026-08-01T00:00:10Z"),
];

describe("sortFolders", () => {
	it("orders numbered names numerically, not lexically", () => {
		expect(sortFolders(numbered, "name-asc").map((f) => f.name)).toEqual([
			"1_Getting Started",
			"2_Command Center",
			"7_Hot/Warm Leads",
			"10_Team Conversations",
			"14_Account & Permissions",
			"23_Support & Contact",
		]);
	});

	it("reverses the natural order for name-desc", () => {
		expect(sortFolders(numbered, "name-desc").map((f) => f.name)).toEqual([
			"23_Support & Contact",
			"14_Account & Permissions",
			"10_Team Conversations",
			"7_Hot/Warm Leads",
			"2_Command Center",
			"1_Getting Started",
		]);
	});

	it("sorts by creation time for newest/oldest", () => {
		const oldest = sortFolders(numbered, "oldest").map((f) => f.id);
		expect(oldest).toEqual(["m", "c", "q", "z", "k", "a"]);
		expect(sortFolders(numbered, "newest").map((f) => f.id)).toEqual(
			[...oldest].reverse(),
		);
	});

	it("ignores case and surrounding whitespace when comparing names", () => {
		const names = sortFolders(
			[
				folder("1", "beta", "2026-01-01"),
				folder("2", "  Alpha", "2026-01-01"),
				folder("3", "Gamma", "2026-01-01"),
			],
			"name-asc",
		).map((f) => f.name);
		expect(names).toEqual(["  Alpha", "beta", "Gamma"]);
	});

	it("breaks name ties by creation time, then id, so order is stable", () => {
		const ids = sortFolders(
			[
				folder("b", "Same", "2026-01-02"),
				folder("a", "Same", "2026-01-02"),
				folder("c", "Same", "2026-01-01"),
			],
			"name-asc",
		).map((f) => f.id);
		expect(ids).toEqual(["c", "a", "b"]);
	});

	it("tolerates missing or malformed createdAt values", () => {
		const ids = sortFolders(
			[
				{ id: "x", name: "B", createdAt: "not a date" },
				{ id: "y", name: "A", createdAt: null },
				{ id: "z", name: "C" },
			],
			"newest",
		).map((f) => f.id);
		// All collapse to time 0, so the name tiebreak decides (reversed for newest).
		expect(ids).toEqual(["z", "x", "y"]);
	});

	it("does not mutate the input array", () => {
		const input = [...numbered];
		sortFolders(input, "name-asc");
		expect(input.map((f) => f.id)).toEqual(numbered.map((f) => f.id));
	});
});

describe("isFolderSort", () => {
	it("accepts known values and rejects anything else", () => {
		expect(isFolderSort("name-asc")).toBe(true);
		expect(isFolderSort("newest")).toBe(true);
		expect(isFolderSort("created")).toBe(false);
		expect(isFolderSort(null)).toBe(false);
	});
});
