export const INFRA_BASE_PATH = "/dashboard/infra";
export const INFRA_APP_COOKIE = "capInfraApp";
export const INFRA_PATH_HEADER = "x-cap-infra-path";

export const INFRA_SECTIONS = [
	{ slug: "", name: "Overview" },
	{ slug: "videos", name: "Videos" },
	{ slug: "audio", name: "Audio" },
	{ slug: "usage", name: "Usage" },
	{ slug: "billing", name: "Billing" },
	{ slug: "keys", name: "API keys" },
	{ slug: "settings", name: "Settings" },
] as const;

export type InfraSection = (typeof INFRA_SECTIONS)[number]["slug"];

const sectionSlugs = new Set<string>(INFRA_SECTIONS.map((s) => s.slug));

export function isInfraSection(value: string): value is InfraSection {
	return sectionSlugs.has(value);
}

export function isInfraPathname(pathname: string) {
	return (
		pathname === INFRA_BASE_PATH || pathname.startsWith(`${INFRA_BASE_PATH}/`)
	);
}

const LOCAL_ORIGIN = "http://local";

export function infraLoginReturnPath(
	requested: string | null | undefined,
	fallback: string = INFRA_BASE_PATH,
) {
	if (!requested?.startsWith("/") || requested.includes("\\")) {
		return fallback;
	}
	try {
		const url = new URL(requested, LOCAL_ORIGIN);
		if (url.origin !== LOCAL_ORIGIN || !isInfraPathname(url.pathname)) {
			return fallback;
		}
		url.searchParams.delete("_rsc");
		return `${url.pathname}${url.search}`;
	} catch {
		return fallback;
	}
}

export function infraAppPath(appId: string, section: InfraSection = "") {
	const base = `${INFRA_BASE_PATH}/${encodeURIComponent(appId)}`;
	return section ? `${base}/${section}` : base;
}

export function parseInfraPathname(pathname: string): {
	appId: string | null;
	section: InfraSection | null;
} {
	if (!isInfraPathname(pathname)) return { appId: null, section: null };
	const [appSegment, sectionSegment = ""] = pathname
		.slice(INFRA_BASE_PATH.length)
		.split("/")
		.filter(Boolean);
	if (!appSegment) return { appId: null, section: null };
	let appId: string;
	try {
		appId = decodeURIComponent(appSegment);
	} catch {
		appId = appSegment;
	}
	return {
		appId,
		section: isInfraSection(sectionSegment) ? sectionSegment : null,
	};
}

export function getInfraPageTitle(pathname: string): string | null {
	if (!isInfraPathname(pathname)) return null;
	const { appId, section } = parseInfraPathname(pathname);
	if (!appId) return "Infra";
	if (section === null) return null;
	return INFRA_SECTIONS.find((s) => s.slug === section)?.name ?? null;
}

export function selectInfraApp<T extends { id: string; createdAt: Date }>(
	apps: readonly T[],
	cookieValue: string | null | undefined,
): T | null {
	if (cookieValue) {
		const remembered = apps.find((app) => app.id === cookieValue);
		if (remembered) return remembered;
	}
	let newest: T | null = null;
	for (const app of apps) {
		if (!newest || app.createdAt.getTime() > newest.createdAt.getTime()) {
			newest = app;
		}
	}
	return newest;
}

export type LegacyDeveloperTarget =
	| { kind: "index" }
	| { kind: "selected"; section: InfraSection }
	| { kind: "app"; appId: string; section: InfraSection };

const legacyAppSections = new Map<string, InfraSection>([
	["settings", "settings"],
	["domains", "settings"],
	["api-keys", "keys"],
	["videos", "videos"],
]);

export function resolveLegacyDeveloperPath(
	segments: readonly string[],
): LegacyDeveloperTarget {
	const [first, second, third] = segments;
	if (first === "usage") return { kind: "selected", section: "usage" };
	if (first === "credits") return { kind: "selected", section: "billing" };
	if (first === "apps" && second) {
		return {
			kind: "app",
			appId: second,
			section: (third && legacyAppSections.get(third)) || "",
		};
	}
	return { kind: "index" };
}
