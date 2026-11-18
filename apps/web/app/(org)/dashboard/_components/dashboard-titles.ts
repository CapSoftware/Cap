export type DashboardCrumb = { label: string; href?: string };

const exact: Record<string, DashboardCrumb[]> = {
	"/dashboard/caps": [{ label: "My Caps" }],
	"/dashboard/caps/archived": [
		{ label: "My Caps", href: "/dashboard/caps" },
		{ label: "Archived" },
	],
	"/dashboard/caps/record": [{ label: "Record a Cap" }],
	"/dashboard/analytics": [{ label: "Analytics" }],
	"/dashboard/import": [{ label: "Import Media" }],
	"/dashboard/import/file": [
		{ label: "Import Media", href: "/dashboard/import" },
		{ label: "Upload a file" },
	],
	"/dashboard/import/loom": [
		{ label: "Import Media", href: "/dashboard/import" },
		{ label: "Loom" },
	],
	"/dashboard/spaces/browse": [{ label: "Spaces" }],
	"/dashboard/settings/account": [{ label: "Account Settings" }],
	"/dashboard/settings/notifications": [{ label: "Notification Settings" }],
	"/dashboard/admin/loom-migrations": [{ label: "Migration Queue" }],
	"/dashboard/refer": [{ label: "Referrals" }],
};

const prefixes: [string, DashboardCrumb[]][] = [
	["/dashboard/settings/organization", [{ label: "Organization Settings" }]],
	["/dashboard/folder/", [{ label: "My Caps", href: "/dashboard/caps" }]],
];

export function dashboardTitle(pathname: string | null): DashboardCrumb[] {
	if (!pathname) return [];
	const path =
		pathname.length > 1 && pathname.endsWith("/")
			? pathname.slice(0, -1)
			: pathname;
	const match = exact[path];
	if (match) return match;
	for (const [prefix, crumbs] of prefixes) {
		if (path === prefix || path.startsWith(prefix)) return crumbs;
	}
	return [];
}
