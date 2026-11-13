import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	queries: [] as string[],
	appId: "app-1",
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const CREATED = "2026-11-01 00:00:00";
	const accountValues: Record<string, unknown> = {
		id: "account-1",
		appId: "app-1",
		ownerId: "user-1",
		balanceMicroCredits: 5_000_000,
		stripeCustomerId: null,
		stripePaymentMethodId: null,
		autoTopUpEnabled: 0,
		autoTopUpThresholdMicroCredits: 0,
		autoTopUpAmountCents: 0,
		createdAt: CREATED,
		updatedAt: CREATED,
	};
	const appValues: Record<string, unknown>[] = [
		{ id: "app-1", name: "First app", environment: "production" },
		{ id: "app-2", name: "Second app", environment: "development" },
	].map((app) => ({
		...app,
		ownerId: "user-1",
		logoUrl: null,
		deletedAt: null,
		createdAt: CREATED,
		updatedAt: CREATED,
	}));
	const selected = (sql: string) =>
		sql
			.slice("select ".length, sql.indexOf(" from "))
			.split(", ")
			.map((column) => column.replaceAll("`", "").split(".").at(-1) ?? "");
	const client = drizzle(async (sql) => {
		state.queries.push(sql);
		if (sql.includes("from `developer_apps`")) {
			return {
				rows: appValues.map((app) => selected(sql).map((name) => app[name])),
			};
		}
		if (
			sql.includes("from `developer_credit_accounts`") &&
			!sql.includes("select COALESCE")
		) {
			return { rows: [selected(sql).map((name) => accountValues[name])] };
		}
		if (sql.includes("COALESCE(SUM(") && !sql.includes("group by")) {
			return { rows: [[0]] };
		}
		if (sql.startsWith("select count(*)")) return { rows: [[0]] };
		return { rows: [] };
	});
	return { db: () => client };
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({
		id: "user-1",
		email: "owner@example.com",
		activeOrganizationId: null,
	}),
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({}),
	NODE_ENV: "production",
}));
vi.mock("next/font/google", () => {
	const font = () => ({ className: "", variable: "", style: {} });
	return { Geist: font, Geist_Mono: font };
});
vi.mock("next/headers", () => ({
	cookies: async () => ({ get: () => undefined }),
	headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
	notFound: () => {
		throw new Error("notFound");
	},
	redirect: (to: string) => {
		throw new Error(`redirect ${to}`);
	},
	usePathname: () => "/dashboard/infra/app-1",
	useRouter: () => ({}),
}));
vi.mock("@/lib/infra-access", () => ({ canUseInfra: () => true }));
vi.mock("@/app/api/utils", async () => {
	const { createMiddleware } = await import("hono/factory");
	return {
		withDeveloperSecretAuth: createMiddleware(async (c, next) => {
			c.set("developerAppId", state.appId);
			await next();
		}),
	};
});

import InfraBillingPage from "@/app/(infra)/dashboard/infra/[appId]/billing/page";
import InfraKeysPage from "@/app/(infra)/dashboard/infra/[appId]/keys/page";
import InfraAppLayout from "@/app/(infra)/dashboard/infra/[appId]/layout";
import InfraOverviewPage from "@/app/(infra)/dashboard/infra/[appId]/page";
import InfraSettingsPage from "@/app/(infra)/dashboard/infra/[appId]/settings/page";
import InfraUsagePage from "@/app/(infra)/dashboard/infra/[appId]/usage/page";
import { app as usageApi } from "@/app/api/developer/v1/[...route]/usage";
import { getInfraBilling, getInfraUploadAdmission } from "@/lib/infra-standing";

const params = { params: Promise.resolve({ appId: "app-1" }) };

const storageAggregates = () =>
	state.queries.filter(
		(sql) => sql.includes("from `developer_videos`") && sql.includes("SUM("),
	);
const reads = (table: string) =>
	state.queries.filter((sql) => sql.includes(`from \`${table}\``));

type Element = { props: Record<string, unknown> };

beforeEach(() => {
	state.queries = [];
});

describe("storage totals are computed once per request", () => {
	it("on the console overview", async () => {
		await InfraOverviewPage(params);

		expect(storageAggregates()).toHaveLength(1);
		expect(state.queries).toHaveLength(12);
	});

	it("on the console usage page", async () => {
		await InfraUsagePage(params);

		expect(storageAggregates()).toHaveLength(1);
	});

	it("on the console billing page", async () => {
		await InfraBillingPage({ ...params, searchParams: Promise.resolve({}) });

		expect(storageAggregates()).toHaveLength(1);
	});

	it("on GET /usage", async () => {
		const response = await usageApi.request("/");

		expect(response.status).toBe(200);
		expect(storageAggregates()).toHaveLength(1);
	});

	it("and not at all when an admission is given the totals it already has", async () => {
		const billing = await getInfraBilling("app-1");
		state.queries = [];

		const admission = await getInfraUploadAdmission(
			"app-1",
			undefined,
			undefined,
			{ storage: billing.storage },
		);

		expect(storageAggregates()).toHaveLength(0);
		expect(admission).toEqual(billing.admission);
	});
});

describe("the billing page lists the ledger without counting it", () => {
	const counts = () =>
		state.queries.filter((sql) => sql.startsWith("select count("));
	const ledgerReads = () =>
		reads("developer_credit_transactions").filter((sql) =>
			sql.includes("inner join `developer_credit_accounts`"),
		);

	it("reads one page and no total", async () => {
		const page = (await InfraBillingPage({
			...params,
			searchParams: Promise.resolve({}),
		})) as Element;

		expect(ledgerReads()).toHaveLength(1);
		expect(ledgerReads()[0]).toContain("limit ?");
		expect(ledgerReads()[0]).not.toContain("offset");
		expect(counts()).toHaveLength(0);
		expect(page.props).toMatchObject({
			transactions: [],
			ledgerPage: { newer: null, older: null },
		});
		expect(page.props).not.toHaveProperty("totalTransactions");
	});

	it("starts from the cursor in the URL", async () => {
		await InfraBillingPage({
			...params,
			searchParams: Promise.resolve({ before: "1794461929000.abc123" }),
		});

		expect(ledgerReads()).toHaveLength(1);
		expect(ledgerReads()[0]).toContain("`createdAt` < ?");
		expect(counts()).toHaveLength(0);
	});
});

describe("the console loads only what a page shows", () => {
	it("reads the app list and the open app's account for the shell, nothing else", async () => {
		const layout = (await InfraAppLayout({
			children: null,
			...params,
		})) as Element;

		expect(state.queries).toHaveLength(2);
		expect(reads("developer_apps")).toHaveLength(1);
		expect(reads("developer_credit_accounts")).toHaveLength(1);
		expect(layout.props.balanceMicroCredits).toBe(5_000_000);
		const shell = layout.props.children as Element;
		expect(shell.props).toMatchObject({
			appId: "app-1",
			balanceMicroCredits: 5_000_000,
			apps: [
				{ id: "app-1", name: "First app", environment: "production" },
				{ id: "app-2", name: "Second app", environment: "development" },
			],
		});
	});

	it("never loads domains, other apps' keys or a video count for the overview", async () => {
		await InfraOverviewPage(params);

		expect(reads("developer_app_domains")).toHaveLength(0);
		expect(reads("developer_api_keys")).toHaveLength(1);
		expect(reads("developer_api_keys")[0]).toContain("`appId` = ?");
		expect(
			state.queries.filter((sql) => sql.includes("count(*)")),
		).toHaveLength(0);
	});

	it("reads one app's keys for the keys page", async () => {
		const page = (await InfraKeysPage(params)) as Element;

		expect(state.queries).toHaveLength(3);
		expect(reads("developer_api_keys")[0]).toContain("`appId` = ?");
		expect(page.props).toEqual({ appId: "app-1", secretKeyPrefix: null });
	});

	it("counts videos only on the settings page, and only for that app", async () => {
		const page = (await InfraSettingsPage(params)) as Element;

		expect(state.queries).toHaveLength(3);
		const [count] = reads("developer_videos");
		expect(count).toContain("count(*)");
		expect(count).toContain("`appId` = ?");
		expect(page.props).toMatchObject({
			appId: "app-1",
			name: "First app",
			environment: "production",
			balanceMicroCredits: 5_000_000,
			videoCount: 0,
		});
	});
});
