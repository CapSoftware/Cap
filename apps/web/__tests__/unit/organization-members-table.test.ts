import { describe, expect, it } from "vitest";
import {
	filterAndSortMembersTableRows,
	type MembersTableQuery,
	type MembersTableRow,
	nextMembersTableSort,
} from "@/lib/organization-members-table";

const rows: (MembersTableRow & { id: string })[] = [
	{
		id: "owner",
		name: "Zoe Owner",
		email: "zoe@example.com",
		role: "owner",
		status: "active",
		joinedAt: new Date("2026-01-10"),
	},
	{
		id: "admin",
		name: "adam Admin",
		email: "adam@example.com",
		role: "admin",
		status: "active",
		joinedAt: new Date("2026-03-01"),
	},
	{
		id: "member",
		name: "Maria Member",
		email: "maria@example.com",
		role: "member",
		status: "pending",
		joinedAt: new Date("2026-02-15"),
	},
	{
		id: "invite",
		name: null,
		email: "bob@example.com",
		role: "member",
		status: "invited",
		joinedAt: null,
	},
];

const baseQuery: MembersTableQuery = {
	search: "",
	role: "all",
	status: "all",
	sort: null,
};

const ids = (query: Partial<MembersTableQuery>) =>
	filterAndSortMembersTableRows(rows, { ...baseQuery, ...query }).map(
		(row) => row.id,
	);

describe("filterAndSortMembersTableRows", () => {
	it("keeps the original order when there is no query", () => {
		expect(ids({})).toEqual(["owner", "admin", "member", "invite"]);
	});

	it("searches name and email case-insensitively", () => {
		expect(ids({ search: "  MARIA " })).toEqual(["member"]);
		expect(ids({ search: "bob@" })).toEqual(["invite"]);
		expect(ids({ search: "example" })).toHaveLength(4);
		expect(ids({ search: "nobody" })).toEqual([]);
	});

	it("filters by role and status together", () => {
		expect(ids({ role: "member" })).toEqual(["member", "invite"]);
		expect(ids({ status: "active" })).toEqual(["owner", "admin"]);
		expect(ids({ role: "member", status: "invited" })).toEqual(["invite"]);
		expect(ids({ role: "admin", status: "pending" })).toEqual([]);
	});

	it("sorts by name ignoring case and keeps rows without a name last", () => {
		expect(ids({ sort: { key: "name", direction: "asc" } })).toEqual([
			"admin",
			"member",
			"owner",
			"invite",
		]);
		expect(ids({ sort: { key: "name", direction: "desc" } })).toEqual([
			"owner",
			"member",
			"admin",
			"invite",
		]);
	});

	it("sorts by email", () => {
		expect(ids({ sort: { key: "email", direction: "asc" } })).toEqual([
			"admin",
			"invite",
			"member",
			"owner",
		]);
	});

	it("sorts by role rank and breaks ties by email", () => {
		expect(ids({ sort: { key: "role", direction: "asc" } })).toEqual([
			"owner",
			"admin",
			"invite",
			"member",
		]);
		expect(ids({ sort: { key: "role", direction: "desc" } })).toEqual([
			"invite",
			"member",
			"admin",
			"owner",
		]);
	});

	it("sorts by join date and keeps pending invites last", () => {
		expect(ids({ sort: { key: "joined", direction: "asc" } })).toEqual([
			"owner",
			"member",
			"admin",
			"invite",
		]);
		expect(ids({ sort: { key: "joined", direction: "desc" } })).toEqual([
			"admin",
			"member",
			"owner",
			"invite",
		]);
	});

	it("does not mutate the input", () => {
		const copy = [...rows];
		filterAndSortMembersTableRows(rows, {
			...baseQuery,
			sort: { key: "email", direction: "desc" },
		});
		expect(rows).toEqual(copy);
	});
});

describe("nextMembersTableSort", () => {
	it("cycles ascending, descending, then off for the same column", () => {
		const asc = nextMembersTableSort(null, "name");
		expect(asc).toEqual({ key: "name", direction: "asc" });
		const desc = nextMembersTableSort(asc, "name");
		expect(desc).toEqual({ key: "name", direction: "desc" });
		expect(nextMembersTableSort(desc, "name")).toBeNull();
	});

	it("starts ascending when switching columns", () => {
		expect(
			nextMembersTableSort({ key: "name", direction: "desc" }, "joined"),
		).toEqual({ key: "joined", direction: "asc" });
	});
});
