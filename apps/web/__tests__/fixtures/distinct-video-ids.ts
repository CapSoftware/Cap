const DISTINCT_IDS_PATTERN =
	/\(select distinct (?<columns>.+?) from .+? order by (?<order>[^)]+?)(?<paging> limit \?(?: offset \?)?)?\) `(?<alias>\w+)`/s;

export function readDistinctVideoIds(queries: string[]) {
	for (const query of queries) {
		const groups = DISTINCT_IDS_PATTERN.exec(query)?.groups;
		if (!groups) continue;
		const { columns, order, paging, alias } = groups;
		return {
			alias,
			paged: Boolean(paging),
			columns: columns?.split(", ") ?? [],
			sortColumns:
				order?.split(", ").map((term) => term.replace(/ (asc|desc)$/, "")) ??
				[],
		};
	}
	return null;
}
