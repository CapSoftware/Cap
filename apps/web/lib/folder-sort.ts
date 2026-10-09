export type FolderSort = "name-asc" | "name-desc" | "newest" | "oldest";

export const FOLDER_SORT_OPTIONS: ReadonlyArray<{
	value: FolderSort;
	label: string;
}> = [
	{ value: "name-asc", label: "Name (A to Z)" },
	{ value: "name-desc", label: "Name (Z to A)" },
	{ value: "newest", label: "Newest first" },
	{ value: "oldest", label: "Oldest first" },
];

export const DEFAULT_FOLDER_SORT: FolderSort = "name-asc";

export const isFolderSort = (value: unknown): value is FolderSort =>
	FOLDER_SORT_OPTIONS.some((option) => option.value === value);

type SortableFolder = {
	id: string;
	name: string;
	createdAt?: Date | string | null;
};

// Natural ordering: "2_Foo" sorts before "10_Bar", and case/accents don't
// split otherwise-equal names apart. Users number their folders, so plain
// lexical order ("1, 10, 11, 2") is the exact complaint this exists to fix.
const collator = new Intl.Collator(undefined, {
	numeric: true,
	sensitivity: "base",
});

const compareName = (a: SortableFolder, b: SortableFolder) =>
	collator.compare(a.name.trim(), b.name.trim()) ||
	// Identical names: keep the earlier-created one first so the order is stable
	// across renders and matches what a "created order" reader expects.
	compareCreated(a, b) ||
	a.id.localeCompare(b.id);

const toTime = (value: SortableFolder["createdAt"]) => {
	if (!value) return 0;
	const time = value instanceof Date ? value.getTime() : Date.parse(value);
	return Number.isNaN(time) ? 0 : time;
};

const compareCreated = (a: SortableFolder, b: SortableFolder) =>
	toTime(a.createdAt) - toTime(b.createdAt);

const compareCreatedThenName = (a: SortableFolder, b: SortableFolder) =>
	compareCreated(a, b) ||
	collator.compare(a.name.trim(), b.name.trim()) ||
	a.id.localeCompare(b.id);

export function sortFolders<T extends SortableFolder>(
	folders: readonly T[],
	sort: FolderSort = DEFAULT_FOLDER_SORT,
): T[] {
	const sorted = [...folders];
	switch (sort) {
		case "name-asc":
			return sorted.sort(compareName);
		case "name-desc":
			return sorted.sort((a, b) => compareName(b, a));
		case "oldest":
			return sorted.sort(compareCreatedThenName);
		case "newest":
			return sorted.sort((a, b) => compareCreatedThenName(b, a));
	}
}
