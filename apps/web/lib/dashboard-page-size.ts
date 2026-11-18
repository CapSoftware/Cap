export const DASHBOARD_PAGE_SIZES = [15, 30, 60, 100] as const;

export type DashboardPageSize = (typeof DASHBOARD_PAGE_SIZES)[number];

export const DEFAULT_DASHBOARD_PAGE_SIZE: DashboardPageSize = 15;

export const MAX_DASHBOARD_PAGE_SIZE = 100;

export function isDashboardPageSize(
	value: unknown,
): value is DashboardPageSize {
	return (
		typeof value === "number" &&
		(DASHBOARD_PAGE_SIZES as readonly number[]).includes(value)
	);
}

// An explicit `?limit=` keeps working for old links and scripts, but it is
// bounded so one request can never ask the dashboard for an unbounded page.
export function resolveDashboardPageSize({
	limitParam,
	preferences,
}: {
	limitParam?: string | string[] | null;
	preferences?: { dashboard?: { pageSize?: unknown } } | null;
}): number {
	const raw = Array.isArray(limitParam) ? limitParam[0] : limitParam;
	if (raw !== undefined && raw !== null && raw !== "") {
		const parsed = Number(raw);
		if (Number.isSafeInteger(parsed) && parsed >= 1)
			return Math.min(parsed, MAX_DASHBOARD_PAGE_SIZE);
	}
	const stored = preferences?.dashboard?.pageSize;
	return isDashboardPageSize(stored) ? stored : DEFAULT_DASHBOARD_PAGE_SIZE;
}
