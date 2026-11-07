import type { OrganizationRole } from "@/lib/permissions/roles";

export type MembersTableStatus = "active" | "pending" | "invited";
export type MembersTableSortKey = "name" | "email" | "role" | "joined";
export type MembersTableSortDirection = "asc" | "desc";

export interface MembersTableSort {
	key: MembersTableSortKey;
	direction: MembersTableSortDirection;
}

export interface MembersTableRow {
	name: string | null;
	email: string;
	role: OrganizationRole;
	status: MembersTableStatus;
	joinedAt: Date | null;
}

export interface MembersTableQuery {
	search: string;
	role: OrganizationRole | "all";
	status: MembersTableStatus | "all";
	sort: MembersTableSort | null;
}

const roleOrder: Record<OrganizationRole, number> = {
	owner: 0,
	admin: 1,
	member: 2,
};

const collator = new Intl.Collator(undefined, { sensitivity: "base" });

function matchesSearch(row: MembersTableRow, search: string) {
	if (!search) return true;
	return `${row.name ?? ""} ${row.email}`.toLocaleLowerCase().includes(search);
}

function compareNullable<T>(
	a: T | null,
	b: T | null,
	compare: (a: T, b: T) => number,
	direction: number,
) {
	if (a === null && b === null) return 0;
	if (a === null) return 1;
	if (b === null) return -1;
	return compare(a, b) * direction;
}

function compareRows(
	a: MembersTableRow,
	b: MembersTableRow,
	{ key, direction }: MembersTableSort,
) {
	const sign = direction === "asc" ? 1 : -1;
	switch (key) {
		case "name":
			return compareNullable(
				a.name?.trim() || null,
				b.name?.trim() || null,
				collator.compare,
				sign,
			);
		case "email":
			return collator.compare(a.email, b.email) * sign;
		case "role":
			return (roleOrder[a.role] - roleOrder[b.role]) * sign;
		case "joined":
			return compareNullable(
				a.joinedAt,
				b.joinedAt,
				(x, y) => x.getTime() - y.getTime(),
				sign,
			);
	}
}

export function filterAndSortMembersTableRows<T extends MembersTableRow>(
	rows: readonly T[],
	query: MembersTableQuery,
): T[] {
	const search = query.search.trim().toLocaleLowerCase();
	const filtered = rows.filter(
		(row) =>
			matchesSearch(row, search) &&
			(query.role === "all" || row.role === query.role) &&
			(query.status === "all" || row.status === query.status),
	);
	const { sort } = query;
	if (!sort) return filtered;
	return filtered
		.map((row, index) => ({ row, index }))
		.sort(
			(a, b) =>
				compareRows(a.row, b.row, sort) ||
				collator.compare(a.row.email, b.row.email) ||
				a.index - b.index,
		)
		.map(({ row }) => row);
}

export function nextMembersTableSort(
	current: MembersTableSort | null,
	key: MembersTableSortKey,
): MembersTableSort | null {
	if (current?.key !== key) return { key, direction: "asc" };
	if (current.direction === "asc") return { key, direction: "desc" };
	return null;
}
