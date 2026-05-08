import {
	type DesktopOrganization,
	DesktopOrganization as DesktopOrganizationSchema,
	type OrganizationBrandColors,
	OrganizationBrandColors as OrganizationBrandColorsSchema,
	type OrganizationBrandingPatchBody,
} from "@cap/web-api-contract";
import { createEffect, createMemo, createSignal } from "solid-js";
import { authStore, recordingSettingsStore } from "~/store";
import { commands } from "./tauri";
import { apiClient, protectedHeaders } from "./web-api";

export type { DesktopOrganization, OrganizationBrandColors };

export type OrganizationAvailability =
	| "signed-out"
	| "loading"
	| "available"
	| "unavailable";

export const EMPTY_ORGANIZATION_BRAND_COLORS = {
	primary: null,
	secondary: null,
	accent: null,
	background: null,
} satisfies OrganizationBrandColors;

export const ORGANIZATION_BRAND_COLOR_LABELS = {
	primary: "Primary",
	secondary: "Secondary",
	accent: "Accent",
	background: "Background",
} satisfies Record<keyof OrganizationBrandColors, string>;

export const ORGANIZATION_BRAND_COLOR_KEYS = [
	"primary",
	"secondary",
	"accent",
	"background",
] as const;

export type OrganizationBrandColorKey =
	(typeof ORGANIZATION_BRAND_COLOR_KEYS)[number];

export type OrganizationBrandColorSwatch = {
	key: OrganizationBrandColorKey;
	label: string;
	color: string;
};

export const ORGANIZATION_BRAND_COLOR_DEFAULTS = {
	primary: "#4785FF",
	secondary: "#FFFFFF",
	accent: "#FF4766",
	background: "#000000",
} satisfies Record<keyof OrganizationBrandColors, string>;

export const ORGANIZATION_LOGO_MAX_BYTES = 1024 * 1024;

export const ORGANIZATION_LOGO_CONTENT_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/avif",
] as const;

const ORGANIZATION_CACHE_FRESH_MS = 45 * 60 * 1000;
const ORGANIZATION_CACHE_RETRY_MS = 60 * 1000;

let organizationRefreshPromise: Promise<void> | null = null;
let lastOrganizationRefreshAtMs = 0;
let lastOrganizationRefreshFailedAtMs = 0;
let lastOrganizationRefreshUserId: string | null = null;

export type CachedAuthStore = {
	secret?: unknown;
	user_id?: string | null;
	organizations?: unknown[];
	organizations_updated_at?: number | null;
};

type CachedAuthWithLocalSession = CachedAuthStore & {
	secret: unknown;
	user_id: string;
};

type AuthStorePatch = NonNullable<Parameters<typeof authStore.set>[0]> & {
	organizations_updated_at?: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBrandColors(value: unknown): OrganizationBrandColors {
	const parsed = OrganizationBrandColorsSchema.safeParse(value);
	if (parsed.success) return parsed.data;
	return EMPTY_ORGANIZATION_BRAND_COLORS;
}

function normalizeBrandColorsForCache(value: unknown): OrganizationBrandColors {
	const colors = normalizeBrandColors(value);

	return {
		primary: colors.primary?.toUpperCase() ?? null,
		secondary: colors.secondary?.toUpperCase() ?? null,
		accent: colors.accent?.toUpperCase() ?? null,
		background: colors.background?.toUpperCase() ?? null,
	};
}

export function normalizeDesktopOrganization(
	value: unknown,
): DesktopOrganization | null {
	const parsed = DesktopOrganizationSchema.safeParse(value);
	if (parsed.success) {
		return {
			...parsed.data,
			brandColors: normalizeBrandColorsForCache(parsed.data.brandColors),
		};
	}
	if (!isRecord(value)) return null;
	if (typeof value.id !== "string" || typeof value.name !== "string")
		return null;

	const role = value.role === "owner" ? "owner" : "member";

	return DesktopOrganizationSchema.parse({
		id: value.id,
		name: value.name,
		ownerId: typeof value.ownerId === "string" ? value.ownerId : "",
		role,
		canEditBrand:
			typeof value.canEditBrand === "boolean"
				? value.canEditBrand
				: role === "owner",
		iconUrl: typeof value.iconUrl === "string" ? value.iconUrl : null,
		brandColors: normalizeBrandColorsForCache(value.brandColors),
	});
}

export function getSelectedOrganizationId(
	organizations: DesktopOrganization[],
	storedId?: string | null,
) {
	if (
		storedId &&
		(organizations.length === 0 ||
			organizations.some((org) => org.id === storedId))
	) {
		return storedId;
	}

	return organizations[0]?.id ?? null;
}

export function getOrganizationBrandColorSwatches(
	organization: DesktopOrganization | null | undefined,
) {
	if (!organization) return [];

	return ORGANIZATION_BRAND_COLOR_KEYS.flatMap((key) => {
		const color = organization.brandColors[key];
		if (!color) return [];

		return {
			key,
			label: ORGANIZATION_BRAND_COLOR_LABELS[key],
			color,
		};
	});
}

function normalizeDesktopOrganizations(values: unknown) {
	if (!Array.isArray(values)) return [];
	return values.flatMap((value) => {
		const organization = normalizeDesktopOrganization(value);
		return organization ? [organization] : [];
	});
}

function hasLocalOrganizationAuth(
	auth: CachedAuthStore | null | undefined,
): auth is CachedAuthWithLocalSession {
	return Boolean(
		auth?.secret && typeof auth.user_id === "string" && auth.user_id.length > 0,
	);
}

function hasRecentOrganizationRefresh(userId: string, now = Date.now()) {
	return (
		lastOrganizationRefreshUserId === userId &&
		lastOrganizationRefreshAtMs > 0 &&
		now - lastOrganizationRefreshAtMs < ORGANIZATION_CACHE_FRESH_MS
	);
}

function hasRecentOrganizationRefreshFailure(userId: string, now = Date.now()) {
	return (
		lastOrganizationRefreshUserId === userId &&
		lastOrganizationRefreshFailedAtMs > 0 &&
		now - lastOrganizationRefreshFailedAtMs < ORGANIZATION_CACHE_RETRY_MS
	);
}

function hasCompleteOrganizationCache(
	auth: CachedAuthWithLocalSession,
	organizations: DesktopOrganization[],
	now = Date.now(),
) {
	if (!Array.isArray(auth.organizations)) return false;
	if (auth.organizations.length !== organizations.length) return false;
	if (
		auth.organizations.some(
			(organization) =>
				!DesktopOrganizationSchema.safeParse(organization).success,
		)
	) {
		return false;
	}

	const updatedAt = auth.organizations_updated_at;
	if (!updatedAt) return false;

	return now - updatedAt * 1000 <= ORGANIZATION_CACHE_FRESH_MS;
}

function shouldRefreshOrganizations(
	auth: CachedAuthStore | null | undefined,
	organizations: DesktopOrganization[],
) {
	if (!hasLocalOrganizationAuth(auth)) return false;
	const userId = auth.user_id;
	const now = Date.now();
	if (hasRecentOrganizationRefreshFailure(userId, now)) return false;
	if (!hasRecentOrganizationRefresh(userId, now)) return true;

	return !hasCompleteOrganizationCache(auth, organizations, now);
}

function markOrganizationRefreshSuccess(userId: string | null) {
	lastOrganizationRefreshUserId = userId;
	lastOrganizationRefreshAtMs = Date.now();
	lastOrganizationRefreshFailedAtMs = 0;
}

function markOrganizationRefreshFailure(userId: string | null) {
	lastOrganizationRefreshUserId = userId;
	lastOrganizationRefreshAtMs = 0;
	lastOrganizationRefreshFailedAtMs = Date.now();
}

export function hasAvailableOrganizationCache(
	auth: CachedAuthStore | null | undefined,
	now = Date.now(),
) {
	if (!hasLocalOrganizationAuth(auth)) return false;

	const organizations = normalizeDesktopOrganizations(auth.organizations);
	return hasCompleteOrganizationCache(auth, organizations, now);
}

export function createDesktopOrganizationsQuery() {
	const auth = authStore.createQuery();
	const [refreshing, setRefreshing] = createSignal(false);

	const hasLocalAuth = createMemo(() => {
		const data = auth.data as CachedAuthStore | null;
		return hasLocalOrganizationAuth(data);
	});

	const signedIn = createMemo(() => {
		const data = auth.data as CachedAuthStore | null;
		return hasAvailableOrganizationCache(data);
	});

	const availability = createMemo<OrganizationAvailability>(() => {
		if (signedIn()) return "available";
		if (!hasLocalAuth()) return "signed-out";
		if (refreshing()) return "loading";
		return "unavailable";
	});

	const organizations = createMemo(() => {
		if (!signedIn()) return [];
		return normalizeDesktopOrganizations(
			(auth.data as CachedAuthStore | null)?.organizations,
		);
	});

	const refresh = async () => {
		const userId =
			(auth.data as CachedAuthStore | null | undefined)?.user_id ?? null;
		if (organizationRefreshPromise) {
			setRefreshing(true);
			try {
				await organizationRefreshPromise;
			} finally {
				setRefreshing(false);
			}
			return;
		}

		setRefreshing(true);
		const promise = commands
			.updateAuthPlan()
			.then(() => {
				markOrganizationRefreshSuccess(userId);
			})
			.catch((error: unknown) => {
				markOrganizationRefreshFailure(userId);
				throw error;
			});
		organizationRefreshPromise = promise;

		try {
			await promise;
			await auth.refetch();
		} finally {
			if (organizationRefreshPromise === promise)
				organizationRefreshPromise = null;
			setRefreshing(false);
		}
	};

	createEffect(() => {
		const data = auth.data as CachedAuthStore | null | undefined;
		if (!shouldRefreshOrganizations(data, organizations())) return;
		void refresh().catch(console.error);
	});

	return {
		auth,
		availability,
		hasLocalAuth,
		organizations,
		refresh,
		refreshing,
		signedIn,
	};
}

export function createSelectedOrganization() {
	const organizationQuery = createDesktopOrganizationsQuery();
	const settings = recordingSettingsStore.createQuery();

	const selectedOrganizationId = createMemo(() =>
		getSelectedOrganizationId(
			organizationQuery.organizations(),
			settings.data?.organizationId ?? null,
		),
	);

	const selectedOrganization = createMemo(() => {
		const id = selectedOrganizationId();
		return (
			organizationQuery
				.organizations()
				.find((organization) => organization.id === id) ?? null
		);
	});

	const setSelectedOrganizationId = async (organizationId: string | null) => {
		await recordingSettingsStore.set({ organizationId });
		await settings.refetch();
	};

	createEffect(() => {
		const storedId = settings.data?.organizationId ?? null;
		const selectedId = selectedOrganizationId();
		if (storedId === selectedId) return;
		if (!storedId && !selectedId) return;
		void setSelectedOrganizationId(selectedId).catch(console.error);
	});

	return {
		...organizationQuery,
		settings,
		selectedOrganization,
		selectedOrganizationId,
		setSelectedOrganizationId,
	};
}

export async function encodeFileAsBase64(file: File) {
	const bytes = new Uint8Array(await file.arrayBuffer());
	const chunkSize = 0x8000;
	const chunks: string[] = [];

	for (let index = 0; index < bytes.length; index += chunkSize) {
		chunks.push(
			String.fromCharCode(...bytes.subarray(index, index + chunkSize)),
		);
	}

	return btoa(chunks.join(""));
}

function getResponseError(body: unknown) {
	if (isRecord(body) && typeof body.error === "string") return body.error;
	return "Failed to update organization branding";
}

function mergeCachedOrganization(
	organizations: unknown[] | undefined,
	organization: DesktopOrganization,
) {
	const normalizedOrganizations = normalizeDesktopOrganizations(organizations);
	const existingIndex = normalizedOrganizations.findIndex(
		(cachedOrganization) => cachedOrganization.id === organization.id,
	);

	if (existingIndex === -1) {
		return [...normalizedOrganizations, organization];
	}

	return normalizedOrganizations.map((cachedOrganization, index) =>
		index === existingIndex ? organization : cachedOrganization,
	);
}

async function updateCachedOrganization(organization: DesktopOrganization) {
	const auth = (await authStore.get()) as CachedAuthStore | null;
	const userId = auth?.user_id ?? null;
	if (!hasLocalOrganizationAuth(auth)) return userId;

	const patch: AuthStorePatch = {
		organizations: mergeCachedOrganization(auth.organizations, organization),
		organizations_updated_at: Math.floor(Date.now() / 1000),
	};

	await authStore.set(patch);
	return userId;
}

export async function updateOrganizationBranding(
	organizationId: string,
	body: OrganizationBrandingPatchBody,
) {
	const response = await apiClient.desktop.updateOrganizationBranding({
		params: { organizationId },
		headers: await protectedHeaders(),
		body,
	});

	if (response.status !== 200) {
		throw new Error(getResponseError(response.body));
	}

	const organization = DesktopOrganizationSchema.parse(response.body);
	let userId: string | null = null;

	try {
		userId = await updateCachedOrganization(organization);
		await commands.updateAuthPlan();
		const auth = (await authStore.get()) as CachedAuthStore | null;
		markOrganizationRefreshSuccess(auth?.user_id ?? userId);
	} catch (error) {
		markOrganizationRefreshFailure(userId);
		console.error(error);
	}

	return organization;
}
