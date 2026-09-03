import { verifySsoLoginIntent } from "@cap/database/auth/sso-state";
import { organizations } from "@cap/database/schema";
import { Organisation, User } from "@cap/web-domain";
import type { SQL } from "drizzle-orm";
import { type AnyMySqlColumn, MySqlDialect } from "drizzle-orm/mysql-core";
import { redirect } from "next/navigation";
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getOrganizationSSOData } from "@/actions/organization/get-organization-sso-data";
import {
	confirmOrganizationSsoCheckout,
	getOrganizationSsoSettings,
	manageOrganizationSsoBilling,
	openOrganizationSsoPortal,
	startOrganizationSsoCheckout,
} from "@/actions/organization/sso";
import OrganizationSecurityPage from "@/app/(org)/dashboard/settings/organization/security/page";
import {
	ensureWorkosOrganization,
	getSsoConfiguration,
} from "@/lib/sso/workos";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	getCurrentUser: vi.fn(),
	getWorkOS: vi.fn(),
	getRegisteredSsoOrganization: vi.fn(),
	getOrganization: vi.fn(),
	getOrganizationByExternalId: vi.fn(),
	createOrganization: vi.fn(),
	listOrganizations: vi.fn(),
	getConnection: vi.fn(),
	listConnections: vi.fn(),
	generateLink: vi.fn(),
	getSsoBilling: vi.fn(),
	syncSsoSubscription: vi.fn(),
	getSsoPrices: vi.fn(),
	createSsoCheckout: vi.fn(),
	attachSsoCheckout: vi.fn(),
	createSsoBillingPortal: vi.fn(),
	setCookie: vi.fn(),
	revalidatePath: vi.fn(),
	isRateLimited: vi.fn(),
	env: {
		WEB_URL: "https://cap.test",
		NEXTAUTH_SECRET: "sso-settings-test-secret",
		WORKOS_API_KEY: "sk_test_fixture",
		WORKOS_CLIENT_ID: "client_test_fixture",
	},
}));

vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@cap/database/auth/sso", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/database/auth/sso")>()),
	getWorkOS: mocks.getWorkOS,
	getRegisteredSsoOrganization: mocks.getRegisteredSsoOrganization,
}));
vi.mock("@cap/env", () => ({
	buildEnv: {},
	serverEnv: () => mocks.env,
}));
vi.mock("@cap/ui", () => ({
	Button: ({ children, disabled }: ComponentProps<"button">) =>
		createElement("button", { disabled, type: "button" }, children),
	Input: "input",
	Card: "section",
	CardDescription: "p",
	CardHeader: "header",
	CardTitle: "h2",
}));
vi.mock("hooks/useCurrency", () => ({
	useCurrency: () => ({ currency: "eur" }),
}));
vi.mock("next/navigation", async (importOriginal) => ({
	...(await importOriginal<typeof import("next/navigation")>()),
	useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock(
	"@/app/(org)/dashboard/settings/organization/components/ComplianceCard",
	() => ({
		ComplianceCard: () =>
			createElement("section", { "aria-label": "Compliance settings" }),
	}),
);
vi.mock(
	"@/app/(org)/dashboard/settings/organization/components/SsoCard",
	() => ({
		SsoCard: ({
			initialSettings,
			checkoutSessionId,
		}: {
			initialSettings: { organizationId: string };
			checkoutSessionId?: string;
		}) =>
			createElement("section", {
				"aria-label": "SSO settings",
				"data-organization-id": initialSettings.organizationId,
				"data-checkout-session-id": checkoutSessionId,
			}),
	}),
);
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/headers", () => ({
	cookies: async () => ({ set: mocks.setCookie }),
}));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: mocks.isRateLimited }));
vi.mock("@/lib/sso/billing", () => ({
	getSsoBilling: mocks.getSsoBilling,
	syncSsoSubscription: mocks.syncSsoSubscription,
	getSsoPrices: mocks.getSsoPrices,
	createSsoCheckout: mocks.createSsoCheckout,
	attachSsoCheckout: mocks.attachSsoCheckout,
	createSsoBillingPortal: mocks.createSsoBillingPortal,
}));

const ORGANIZATION_ID = Organisation.OrganisationId.make("a".repeat(15));
const OTHER_ORGANIZATION_ID = Organisation.OrganisationId.make("b".repeat(15));
const OWNER_ID = User.UserId.make("owner");
const WORKOS_ORGANIZATION_ID = "org_company";
const CONNECTION_ID = "conn_company";
const SETTINGS_PATH = "/dashboard/settings/organization/security";
const dialect = new MySqlDialect();

type Row = Record<string, unknown>;
type CapOrganization = typeof organizations.$inferSelect;

function matchesRow(condition: SQL | undefined, row: Row) {
	if (!condition) return true;
	const query = dialect.sqlToQuery(condition);
	let parameterIndex = 0;
	return query.sql
		.replaceAll("(", "")
		.replaceAll(")", "")
		.split(" and ")
		.map((clause) => {
			const match = /^`[^`]+`\.`([^`]+)`( = \?| is null| in [?, ]+)$/.exec(
				clause,
			);
			if (!match?.[1]) throw new Error(`Unsupported predicate: ${clause}`);
			if (match[2] === " is null") return row[match[1]] == null;
			if (match[2] === " = ?") {
				return row[match[1]] === query.params[parameterIndex++];
			}
			const count = clause.match(/\?/g)?.length ?? 0;
			const values = query.params.slice(parameterIndex, parameterIndex + count);
			parameterIndex += count;
			return values.includes(row[match[1]]);
		})
		.every(Boolean);
}

function makeFixture({
	role = "owner",
	paid = true,
	linked = true,
	verified = true,
}: {
	role?: "owner" | "admin" | "member" | "stranger" | "forged-owner";
	paid?: boolean;
	linked?: boolean;
	verified?: boolean;
} = {}) {
	const actorId = role === "owner" ? OWNER_ID : User.UserId.make(role);
	const user = {
		id: actorId,
		email: "admin@example.com",
		stripeCustomerId: "cus_owner",
		activeOrganizationId: ORGANIZATION_ID,
	};
	const organization: CapOrganization = {
		id: ORGANIZATION_ID,
		name: "Company",
		ownerId: OWNER_ID,
		metadata: null,
		tombstoneAt: null,
		allowedEmailDomain: null,
		customDomain: null,
		domainVerified: null,
		settings: null,
		iconUrl: null,
		shareableLinkIconUrl: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
		workosOrganizationId: linked ? WORKOS_ORGANIZATION_ID : null,
		workosConnectionId: null,
	};
	const localOrganizations = [organization];
	const remote = {
		id: WORKOS_ORGANIZATION_ID,
		name: "Company",
		externalId: ORGANIZATION_ID as string,
		domains: [
			{ domain: "example.com", state: verified ? "verified" : "pending" },
		],
	};
	const remoteOrganizations = [remote];
	const connection = {
		id: CONNECTION_ID,
		organizationId: WORKOS_ORGANIZATION_ID,
		name: "Company SAML",
		state: "active",
		connectionType: "SAML",
	};
	const connections = [connection];
	const billing = paid
		? {
				stripeSubscriptionId: "sub_sso",
				status: "active",
				paidThrough: new Date(Date.now() + 86_400_000),
				currentPeriodEnd: new Date(Date.now() + 86_400_000),
				cancelAtPeriodEnd: false,
			}
		: null;
	const hooks: { beforeUpdate?: () => void } = {};
	const database = {
		select: vi.fn((columns?: Record<string, AnyMySqlColumn>) => {
			let joined = false;
			let condition: SQL | undefined;
			const selection = {
				from: (table: unknown) => {
					if (table !== organizations) throw new Error("Unexpected table");
					return selection;
				},
				leftJoin: () => {
					joined = true;
					return selection;
				},
				where: (predicate: SQL | undefined) => {
					condition = predicate;
					return selection;
				},
				limit: async (count: number) => {
					if (joined) {
						if (!condition) throw new Error("Missing authorization predicate");
						const [requestedOrganizationId, requestedUserId] =
							dialect.sqlToQuery(condition).params;
						return localOrganizations
							.filter(
								(row) =>
									row.id === requestedOrganizationId &&
									!row.tombstoneAt &&
									requestedUserId === actorId &&
									(row.ownerId === actorId || role !== "stranger"),
							)
							.slice(0, count)
							.map((row) => ({
								id: row.id,
								ownerId: row.ownerId,
								memberId: role === "owner" ? null : "membership",
								memberRole: role === "forged-owner" ? "owner" : role,
							}));
					}
					return localOrganizations
						.filter((row) => matchesRow(condition, row))
						.slice(0, count)
						.map((row) =>
							columns
								? Object.fromEntries(
										Object.entries(columns).map(([key, column]) => [
											key,
											(row as Row)[column.name],
										]),
									)
								: { ...row },
						);
				},
			};
			return selection;
		}),
		update: vi.fn(() => ({
			set: (patch: Row) => ({
				where: async (condition: SQL | undefined) => {
					hooks.beforeUpdate?.();
					for (const row of localOrganizations) {
						if (matchesRow(condition, row)) Object.assign(row, patch);
					}
				},
			}),
		})),
	};
	mocks.db.mockReturnValue(database);
	mocks.getCurrentUser.mockResolvedValue(user);
	mocks.getWorkOS.mockReturnValue({
		organizations: {
			getOrganization: mocks.getOrganization,
			getOrganizationByExternalId: mocks.getOrganizationByExternalId,
			createOrganization: mocks.createOrganization,
			listOrganizations: mocks.listOrganizations,
		},
		sso: {
			getConnection: mocks.getConnection,
			listConnections: mocks.listConnections,
		},
		portal: { generateLink: mocks.generateLink },
	});
	mocks.getRegisteredSsoOrganization.mockResolvedValue(organization);
	mocks.getOrganization.mockResolvedValue(remote);
	mocks.getOrganizationByExternalId.mockResolvedValue(remote);
	mocks.createOrganization.mockResolvedValue(remote);
	mocks.listOrganizations.mockResolvedValue({
		data: remoteOrganizations,
		listMetadata: { after: null },
	});
	mocks.getConnection.mockResolvedValue(connection);
	mocks.listConnections.mockResolvedValue({
		data: connections,
		listMetadata: { after: null },
	});
	mocks.generateLink.mockResolvedValue({
		link: "https://admin.workos.test/setup",
	});
	mocks.getSsoBilling.mockResolvedValue(billing);
	mocks.syncSsoSubscription.mockResolvedValue(billing);
	mocks.getSsoPrices.mockResolvedValue([
		{ currency: "usd", unitAmount: 20_000 },
		{ currency: "gbp", unitAmount: 16_000 },
		{ currency: "eur", unitAmount: 19_000 },
	]);
	mocks.createSsoCheckout.mockResolvedValue("https://checkout.stripe.test/sso");
	mocks.attachSsoCheckout.mockResolvedValue(billing);
	mocks.createSsoBillingPortal.mockResolvedValue(
		"https://billing.stripe.test/sso",
	);
	mocks.isRateLimited.mockResolvedValue(false);
	return {
		user,
		organization,
		localOrganizations,
		remote,
		remoteOrganizations,
		connection,
		connections,
		billing,
		database,
		hooks,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.env.WORKOS_API_KEY = "sk_test_fixture";
	mocks.env.WORKOS_CLIENT_ID = "client_test_fixture";
});

describe("organization SSO settings authorization", () => {
	it("keeps paid SSO setup available when billing currency lookup fails", async () => {
		makeFixture();
		mocks.getSsoPrices.mockRejectedValue(new Error("Stripe unavailable"));
		const settings = await getOrganizationSsoSettings(ORGANIZATION_ID);
		expect(settings.entitled).toBe(true);
		expect(settings.prices).toEqual([]);
		expect(settings.connection?.state).toBe("active");
		await expect(openOrganizationSsoPortal(ORGANIZATION_ID)).resolves.toEqual({
			url: "https://admin.workos.test/setup",
		});
	});

	it.each(["owner", "admin"] as const)(
		"lets a %s read setup status with owner-only billing controls",
		async (role) => {
			makeFixture({ role });
			const settings = await getOrganizationSsoSettings(ORGANIZATION_ID);
			expect(settings).toMatchObject({
				organizationId: ORGANIZATION_ID,
				canManageBilling: role === "owner",
				entitled: true,
				suggestedDomain: "example.com",
				signInUrl: `https://cap.test/login?organizationId=${ORGANIZATION_ID}`,
			});
			expect(mocks.syncSsoSubscription).toHaveBeenCalledWith("sub_sso");
			expect(mocks.getSsoPrices).toHaveBeenCalledWith(ORGANIZATION_ID);
		},
	);

	it.each([
		["usd", "$200.00"],
		["gbp", "£200.00"],
		["eur", "€200.00"],
	] as const)(
		"renders only the existing %s currency without asking the owner to choose",
		async (currency, amount) => {
			makeFixture({ paid: false, linked: false });
			mocks.getSsoPrices.mockResolvedValue([{ currency, unitAmount: 20000 }]);
			const { SsoCard } = await vi.importActual<
				typeof import("@/app/(org)/dashboard/settings/organization/components/SsoCard")
			>("@/app/(org)/dashboard/settings/organization/components/SsoCard");
			const markup = renderToStaticMarkup(
				createElement(SsoCard, {
					initialSettings: await getOrganizationSsoSettings(ORGANIZATION_ID),
				}),
			);
			expect(markup).toContain(`Add SAML SSO · ${amount}/month`);
			expect(markup).not.toContain("Billing currency");
			expect(markup).not.toContain("<select");
		},
	);

	it("keeps the currency picker when the owner has no current subscription", async () => {
		makeFixture({ paid: false, linked: false });
		const { SsoCard } = await vi.importActual<
			typeof import("@/app/(org)/dashboard/settings/organization/components/SsoCard")
		>("@/app/(org)/dashboard/settings/organization/components/SsoCard");
		const markup = renderToStaticMarkup(
			createElement(SsoCard, {
				initialSettings: await getOrganizationSsoSettings(ORGANIZATION_ID),
			}),
		);
		expect(markup).toContain("Billing currency");
		expect(markup).toContain("<select");
		expect(markup).toContain("Add SAML SSO · €190.00/month");
	});

	it.each(["member", "stranger", "forged-owner"] as const)(
		"denies %s access before opening setup or billing",
		async (role) => {
			makeFixture({ role });
			await expect(
				getOrganizationSsoSettings(ORGANIZATION_ID),
			).rejects.toThrow();
			await expect(
				openOrganizationSsoPortal(ORGANIZATION_ID),
			).rejects.toThrow();
			await expect(
				startOrganizationSsoCheckout(ORGANIZATION_ID, "usd"),
			).rejects.toThrow();
			expect(mocks.getSsoBilling).not.toHaveBeenCalled();
			expect(mocks.generateLink).not.toHaveBeenCalled();
			expect(mocks.createSsoCheckout).not.toHaveBeenCalled();
		},
	);

	it("rejects signed-out requests and another organization's checkout", async () => {
		makeFixture();
		await expect(
			startOrganizationSsoCheckout(OTHER_ORGANIZATION_ID, "usd"),
		).rejects.toThrow("Forbidden");
		mocks.getCurrentUser.mockResolvedValue(null);
		await expect(getOrganizationSsoSettings(ORGANIZATION_ID)).rejects.toThrow(
			"Unauthorized",
		);
		await expect(openOrganizationSsoPortal(ORGANIZATION_ID)).rejects.toThrow(
			"Unauthorized",
		);
		expect(mocks.generateLink).not.toHaveBeenCalled();
		expect(mocks.createSsoCheckout).not.toHaveBeenCalled();
	});

	it("lets a paid admin configure SSO without creating a charge", async () => {
		makeFixture({ role: "admin" });
		await expect(openOrganizationSsoPortal(ORGANIZATION_ID)).resolves.toEqual({
			url: "https://admin.workos.test/setup",
		});
		expect(mocks.generateLink).toHaveBeenCalledWith(
			expect.objectContaining({
				organization: WORKOS_ORGANIZATION_ID,
				intent: "sso",
				returnUrl: `https://cap.test${SETTINGS_PATH}?organizationId=${ORGANIZATION_ID}`,
			}),
		);
		expect(mocks.createSsoCheckout).not.toHaveBeenCalled();
	});

	it("keeps checkout, confirmation and billing management owner-only", async () => {
		makeFixture({ role: "admin" });
		await expect(
			startOrganizationSsoCheckout(ORGANIZATION_ID, "usd"),
		).rejects.toThrow("Only the owner");
		await expect(
			confirmOrganizationSsoCheckout(ORGANIZATION_ID, "cs_paid"),
		).rejects.toThrow("Only the owner");
		await expect(manageOrganizationSsoBilling(ORGANIZATION_ID)).rejects.toThrow(
			"Only the owner",
		);
		expect(mocks.createSsoCheckout).not.toHaveBeenCalled();
		expect(mocks.attachSsoCheckout).not.toHaveBeenCalled();
		expect(mocks.createSsoBillingPortal).not.toHaveBeenCalled();
	});

	it("does not create WorkOS resources or portal links for unpaid organizations", async () => {
		makeFixture({ paid: false, linked: false });
		const settings = await getOrganizationSsoSettings(ORGANIZATION_ID);
		expect(settings.entitled).toBe(false);
		expect(settings.signInUrl).toBeNull();
		await expect(
			openOrganizationSsoPortal(ORGANIZATION_ID, "example.com"),
		).rejects.toThrow("active SAML SSO add-on");
		expect(mocks.createOrganization).not.toHaveBeenCalled();
		expect(mocks.generateLink).not.toHaveBeenCalled();
	});

	it("rechecks current billing before opening a previously paid setup", async () => {
		const fixture = makeFixture();
		mocks.syncSsoSubscription.mockResolvedValue({
			...fixture.billing,
			status: "canceled",
		});
		await expect(openOrganizationSsoPortal(ORGANIZATION_ID)).rejects.toThrow(
			"active SAML SSO add-on",
		);
		expect(mocks.generateLink).not.toHaveBeenCalled();
	});

	it.each(["usd", "gbp", "eur"])(
		"binds a %s checkout to the authenticated owner and requested organization",
		async (currency) => {
			const fixture = makeFixture({ paid: false });
			await expect(
				startOrganizationSsoCheckout(ORGANIZATION_ID, currency),
			).resolves.toEqual({ url: "https://checkout.stripe.test/sso" });
			expect(mocks.createSsoCheckout).toHaveBeenCalledWith({
				organizationId: ORGANIZATION_ID,
				purchasedByUserId: fixture.user.id,
				stripeCustomerId: fixture.user.stripeCustomerId,
				currency,
			});
		},
	);

	it("rejects an unsupported currency before starting checkout", async () => {
		makeFixture();
		await expect(
			startOrganizationSsoCheckout(ORGANIZATION_ID, "jpy"),
		).rejects.toThrow("Unsupported billing currency");
		expect(mocks.createSsoCheckout).not.toHaveBeenCalled();
	});

	it.each(["complete", "sso_setup=complete", "cs_", `cs_${"a".repeat(253)}`])(
		"does not treat %s as a verified payment return",
		async (sessionId) => {
			makeFixture({ paid: false });
			await expect(
				confirmOrganizationSsoCheckout(ORGANIZATION_ID, sessionId),
			).rejects.toThrow("Invalid checkout session");
			expect(mocks.attachSsoCheckout).not.toHaveBeenCalled();
		},
	);

	it("confirms checkout against the expected organization and owner", async () => {
		makeFixture();
		const settings = await confirmOrganizationSsoCheckout(
			ORGANIZATION_ID,
			"cs_verified",
		);
		expect(mocks.attachSsoCheckout).toHaveBeenCalledWith("cs_verified", {
			organizationId: ORGANIZATION_ID,
			userId: OWNER_ID,
		});
		expect(settings.entitled).toBe(true);
		expect(mocks.revalidatePath).toHaveBeenCalledWith(SETTINGS_PATH);
	});

	it("does not unlock setup when a checkout has no paid entitlement", async () => {
		makeFixture({ paid: false });
		mocks.attachSsoCheckout.mockResolvedValue({
			status: "active",
			paidThrough: null,
		});
		await expect(
			confirmOrganizationSsoCheckout(ORGANIZATION_ID, "cs_pending"),
		).rejects.toThrow("payment is still processing");
		expect(mocks.revalidatePath).not.toHaveBeenCalled();
	});

	it("preserves checkout ownership errors from Stripe reconciliation", async () => {
		makeFixture();
		mocks.attachSsoCheckout.mockRejectedValue(
			new Error("Checkout belongs to another organization"),
		);
		await expect(
			confirmOrganizationSsoCheckout(ORGANIZATION_ID, "cs_other"),
		).rejects.toThrow("another organization");
		expect(mocks.revalidatePath).not.toHaveBeenCalled();
	});

	it("does not advertise sign-in until the domain is verified", async () => {
		makeFixture({ verified: false });
		const settings = await getOrganizationSsoSettings(ORGANIZATION_ID);
		expect(settings.entitled).toBe(true);
		expect(settings.domains).toEqual([
			{ domain: "example.com", state: "pending" },
		]);
		expect(settings.signInUrl).toBeNull();
	});

	it("opens domain verification before SSO setup and rechecks the live domain state", async () => {
		const fixture = makeFixture({ verified: false });
		await openOrganizationSsoPortal(ORGANIZATION_ID);
		expect(mocks.generateLink).toHaveBeenLastCalledWith({
			organization: WORKOS_ORGANIZATION_ID,
			intent: "domain_verification",
			returnUrl: `https://cap.test${SETTINGS_PATH}?organizationId=${ORGANIZATION_ID}`,
			successUrl: `https://cap.test${SETTINGS_PATH}?organizationId=${ORGANIZATION_ID}&sso_setup=complete`,
		});
		fixture.remote.domains = [{ domain: "example.com", state: "verified" }];
		await openOrganizationSsoPortal(ORGANIZATION_ID);
		expect(mocks.generateLink).toHaveBeenLastCalledWith(
			expect.objectContaining({
				organization: WORKOS_ORGANIZATION_ID,
				intent: "sso",
			}),
		);
	});

	it("lets a paid admin verify another domain without leaving the organization scope", async () => {
		const fixture = makeFixture({ role: "admin" });
		fixture.remote.domains.push({ domain: "example.org", state: "pending" });
		await openOrganizationSsoPortal(
			ORGANIZATION_ID,
			undefined,
			"domain_verification",
		);
		expect(mocks.generateLink).toHaveBeenLastCalledWith(
			expect.objectContaining({
				organization: WORKOS_ORGANIZATION_ID,
				intent: "domain_verification",
				returnUrl: `https://cap.test${SETTINGS_PATH}?organizationId=${ORGANIZATION_ID}`,
			}),
		);
	});
});

describe("organization security page SSO failure isolation", () => {
	it.each([
		["WorkOS", "getOrganization", 404],
		["WorkOS", "getOrganization", 503],
		["Stripe", "syncSsoSubscription", 503],
	] as const)(
		"preserves compliance settings when %s %s fails with %s",
		async (provider, method, status) => {
			makeFixture();
			const error = Object.assign(new Error(`${provider} private detail`), {
				status,
			});
			mocks[method].mockRejectedValueOnce(error);
			const markup = renderToStaticMarkup(
				await OrganizationSecurityPage({ searchParams: Promise.resolve({}) }),
			);
			expect(markup).toContain("Unable to load SAML SSO settings.");
			expect(markup).toContain("Reload this page to try again.");
			expect(markup).toContain('href="mailto:hello@cap.so"');
			expect(markup).toContain('aria-label="Compliance settings"');
			expect(markup).not.toContain('aria-label="SSO settings"');
			expect(markup).not.toContain(error.message);
		},
	);

	it("does not swallow an authentication redirect during settings loading", async () => {
		const fixture = makeFixture();
		mocks.getCurrentUser
			.mockResolvedValueOnce(fixture.user)
			.mockImplementationOnce(() => redirect("/auth/signin"));
		await expect(
			OrganizationSecurityPage({ searchParams: Promise.resolve({}) }),
		).rejects.toMatchObject({
			digest: expect.stringContaining("/auth/signin"),
		});
		expect(mocks.getSsoBilling).not.toHaveBeenCalled();
	});

	it("passes successful settings and checkout confirmation to the normal SSO card", async () => {
		makeFixture();
		const markup = renderToStaticMarkup(
			await OrganizationSecurityPage({
				searchParams: Promise.resolve({
					organizationId: ORGANIZATION_ID,
					sso_checkout: "cs_verified",
				}),
			}),
		);
		expect(markup).toContain('aria-label="Compliance settings"');
		expect(markup).toContain('aria-label="SSO settings"');
		expect(markup).toContain(`data-organization-id="${ORGANIZATION_ID}"`);
		expect(markup).toContain('data-checkout-session-id="cs_verified"');
	});
});

describe("WorkOS organization setup binding", () => {
	it("creates a pending domain with a stable external ID and idempotency key", async () => {
		const fixture = makeFixture({ linked: false, verified: false });
		mocks.getOrganizationByExternalId.mockRejectedValueOnce({ status: 404 });
		await ensureWorkosOrganization(ORGANIZATION_ID, " EXAMPLE.COM ");
		await ensureWorkosOrganization(ORGANIZATION_ID, "different.example");
		expect(mocks.createOrganization).toHaveBeenCalledExactlyOnceWith(
			{
				name: "Company",
				externalId: ORGANIZATION_ID,
				domainData: [{ domain: "example.com", state: "pending" }],
			},
			{ idempotencyKey: `cap-sso-organization:${ORGANIZATION_ID}` },
		);
		expect(fixture.organization.workosOrganizationId).toBe(
			WORKOS_ORGANIZATION_ID,
		);
		expect(fixture.database.update).toHaveBeenCalledTimes(1);
	});

	it("recovers an existing external-ID mapping without creating another organization", async () => {
		const fixture = makeFixture({ linked: false });
		await ensureWorkosOrganization(ORGANIZATION_ID, "example.com");
		expect(mocks.getOrganizationByExternalId).toHaveBeenCalledWith(
			ORGANIZATION_ID,
		);
		expect(mocks.createOrganization).not.toHaveBeenCalled();
		expect(fixture.organization.workosOrganizationId).toBe(
			WORKOS_ORGANIZATION_ID,
		);
	});

	it("does not bind a same-name WorkOS organization with a different external ID", async () => {
		const fixture = makeFixture({ linked: false });
		fixture.remote.externalId = OTHER_ORGANIZATION_ID;
		await expect(
			ensureWorkosOrganization(ORGANIZATION_ID, "example.com"),
		).rejects.toThrow("could not be verified");
		expect(fixture.database.update).not.toHaveBeenCalled();
		expect(mocks.listOrganizations).not.toHaveBeenCalled();
		expect(fixture.organization.workosOrganizationId).toBeNull();
	});

	it("recovers a concurrent WorkOS create only by its expected external ID", async () => {
		const fixture = makeFixture({ linked: false });
		mocks.getOrganizationByExternalId.mockRejectedValueOnce({ status: 404 });
		mocks.createOrganization.mockRejectedValue(
			new Error("Duplicate external ID"),
		);
		await ensureWorkosOrganization(ORGANIZATION_ID, "example.com");
		expect(mocks.getOrganizationByExternalId).toHaveBeenCalledTimes(2);
		expect(fixture.organization.workosOrganizationId).toBe(
			WORKOS_ORGANIZATION_ID,
		);
	});

	it("does not create a duplicate after a WorkOS lookup outage", async () => {
		makeFixture({ linked: false });
		mocks.getOrganizationByExternalId.mockRejectedValue({ status: 503 });
		await expect(
			ensureWorkosOrganization(ORGANIZATION_ID, "example.com"),
		).rejects.toEqual({ status: 503 });
		expect(mocks.createOrganization).not.toHaveBeenCalled();
	});

	it("does not overwrite an organization mapping that changed during setup", async () => {
		const fixture = makeFixture({ linked: false });
		fixture.hooks.beforeUpdate = () => {
			fixture.organization.workosOrganizationId = "org_concurrent";
		};
		await expect(
			ensureWorkosOrganization(ORGANIZATION_ID, "example.com"),
		).rejects.toThrow("organization changed");
		expect(fixture.organization.workosOrganizationId).toBe("org_concurrent");
	});

	it("does not create resources for a deleted Cap organization", async () => {
		const fixture = makeFixture({ linked: false });
		fixture.organization.tombstoneAt = new Date();
		await expect(
			ensureWorkosOrganization(ORGANIZATION_ID, "example.com"),
		).rejects.toThrow("Organization not found");
		expect(mocks.getOrganizationByExternalId).not.toHaveBeenCalled();
	});

	it("rejects a WorkOS response for a different organization ID", async () => {
		const fixture = makeFixture();
		fixture.remote.id = "org_other";
		await expect(getSsoConfiguration(fixture.organization)).rejects.toThrow(
			"could not be verified",
		);
		await expect(ensureWorkosOrganization(ORGANIZATION_ID)).rejects.toThrow(
			"could not be verified",
		);
	});

	it("rejects a connection belonging to a different WorkOS organization", async () => {
		const fixture = makeFixture();
		fixture.connection.organizationId = "org_other";
		await expect(getSsoConfiguration(fixture.organization)).rejects.toThrow(
			"could not be verified",
		);
	});

	it("does not choose a sign-in connection from an incomplete page", async () => {
		const fixture = makeFixture();
		mocks.listConnections.mockResolvedValue({
			data: fixture.connections,
			listMetadata: { after: "conn_next" },
		});
		await expect(getSsoConfiguration(fixture.organization)).rejects.toThrow(
			"too many SSO connections",
		);
	});

	it("keeps settings manageable while an ambiguous default blocks discovery", async () => {
		const fixture = makeFixture();
		fixture.connections.push({ ...fixture.connection, id: "conn_second" });
		await expect(
			getSsoConfiguration(fixture.organization),
		).resolves.toMatchObject({
			requiresConnectionSelection: true,
			connection: null,
		});
		const settings = await getOrganizationSsoSettings(ORGANIZATION_ID);
		expect(settings.connectionIssue).toContain("Multiple SSO connections");
		expect(settings.signInUrl).toBeNull();
		await expect(getOrganizationSSOData("example.com")).rejects.toThrow(
			"SSO setup is not complete",
		);
		await expect(
			getOrganizationSSOData("", CONNECTION_ID),
		).resolves.toMatchObject({
			connectionId: CONNECTION_ID,
		});
		await expect(
			openOrganizationSsoPortal(ORGANIZATION_ID),
		).resolves.toMatchObject({
			url: expect.any(String),
		});
		fixture.organization.workosConnectionId = "conn_second";
		const configuration = await getSsoConfiguration(fixture.organization);
		expect(configuration?.connection?.id).toBe("conn_second");
	});
});

describe("SSO sign-in discovery", () => {
	it("resolves a verified work email and binds the signed intent to its organization", async () => {
		makeFixture();
		mocks.getCurrentUser.mockResolvedValue(null);
		await expect(getOrganizationSSOData("Person@EXAMPLE.COM")).resolves.toEqual(
			{
				organizationId: WORKOS_ORGANIZATION_ID,
				connectionId: CONNECTION_ID,
				name: "Company",
			},
		);
		expect(mocks.listOrganizations).toHaveBeenCalledWith({
			domains: ["example.com"],
			limit: 100,
		});
		const cookie = mocks.setCookie.mock.calls[0];
		expect(cookie?.[0]).toBe("__Host-cap-sso-intent");
		expect(cookie?.[2]).toMatchObject({
			httpOnly: true,
			secure: true,
			sameSite: "lax",
			path: "/",
			maxAge: 600,
		});
		expect(
			verifySsoLoginIntent(cookie?.[1], mocks.env.NEXTAUTH_SECRET),
		).toMatchObject({
			organizationId: ORGANIZATION_ID,
			workosOrganizationId: WORKOS_ORGANIZATION_ID,
			connectionId: CONNECTION_ID,
			actorId: null,
		});
	});

	it("keeps shared organization links and binds an existing signed-in actor", async () => {
		makeFixture();
		await getOrganizationSSOData(ORGANIZATION_ID);
		expect(mocks.listOrganizations).not.toHaveBeenCalled();
		const signedIntent = mocks.setCookie.mock.calls[0]?.[1];
		expect(
			verifySsoLoginIntent(signedIntent, mocks.env.NEXTAUTH_SECRET),
		).toMatchObject({
			organizationId: ORGANIZATION_ID,
			actorId: OWNER_ID,
		});
	});

	it("restarts an IdP-initiated connection through signed application state", async () => {
		makeFixture();
		await expect(
			getOrganizationSSOData("", CONNECTION_ID),
		).resolves.toMatchObject({
			organizationId: WORKOS_ORGANIZATION_ID,
			connectionId: CONNECTION_ID,
		});
		expect(mocks.getConnection).toHaveBeenCalledWith(CONNECTION_ID);
		expect(mocks.setCookie).toHaveBeenCalledOnce();
	});

	it("rejects an unverified domain even when its organization has the same name", async () => {
		makeFixture({ verified: false });
		await expect(getOrganizationSSOData("example.com")).rejects.toThrow(
			"SSO is not configured",
		);
		expect(mocks.getSsoBilling).not.toHaveBeenCalled();
		expect(mocks.setCookie).not.toHaveBeenCalled();
	});

	it("does not permit a share link to skip domain verification", async () => {
		makeFixture({ verified: false });
		await expect(getOrganizationSSOData(ORGANIZATION_ID)).rejects.toThrow(
			"SSO setup is not complete",
		);
		expect(mocks.setCookie).not.toHaveBeenCalled();
	});

	it("does not start sign-in after the authoritative entitlement is canceled", async () => {
		const fixture = makeFixture();
		mocks.syncSsoSubscription.mockResolvedValue({
			...fixture.billing,
			status: "canceled",
		});
		await expect(getOrganizationSSOData("example.com")).rejects.toThrow(
			"SSO is not available",
		);
		expect(mocks.setCookie).not.toHaveBeenCalled();
	});

	it("rejects an inactive or unregistered IdP connection", async () => {
		const fixture = makeFixture();
		fixture.connection.state = "inactive";
		await expect(getOrganizationSSOData("", CONNECTION_ID)).rejects.toThrow(
			"SSO is not configured",
		);
		fixture.connection.state = "active";
		fixture.connection.organizationId = "org_unknown";
		await expect(getOrganizationSSOData("", CONNECTION_ID)).rejects.toThrow(
			"SSO is not configured",
		);
		expect(mocks.setCookie).not.toHaveBeenCalled();
	});

	it("rejects a connection that changes organization during discovery", async () => {
		const fixture = makeFixture();
		mocks.getConnection
			.mockResolvedValueOnce(fixture.connection)
			.mockResolvedValueOnce({
				...fixture.connection,
				organizationId: "org_other",
			});
		await expect(getOrganizationSSOData("", CONNECTION_ID)).rejects.toThrow(
			"SSO setup is not complete",
		);
		expect(mocks.setCookie).not.toHaveBeenCalled();
	});

	it("requires an administrator's link for an ambiguous verified domain", async () => {
		const fixture = makeFixture();
		fixture.remoteOrganizations.push({ ...fixture.remote, id: "org_second" });
		fixture.localOrganizations.push({
			...fixture.organization,
			id: OTHER_ORGANIZATION_ID,
			workosOrganizationId: "org_second",
		});
		await expect(getOrganizationSSOData("example.com")).rejects.toThrow(
			"sign-in link provided by your administrator",
		);
		expect(mocks.setCookie).not.toHaveBeenCalled();
	});

	it("rejects incomplete paginated domain results", async () => {
		const fixture = makeFixture();
		mocks.listOrganizations.mockResolvedValue({
			data: fixture.remoteOrganizations,
			listMetadata: { after: "org_next" },
		});
		await expect(getOrganizationSSOData("example.com")).rejects.toThrow(
			"SSO is not configured",
		);
		expect(mocks.setCookie).not.toHaveBeenCalled();
	});

	it("rate-limits discovery before accessing WorkOS", async () => {
		makeFixture();
		mocks.isRateLimited.mockResolvedValue(true);
		await expect(getOrganizationSSOData("example.com")).rejects.toThrow(
			"Too many SSO attempts",
		);
		expect(mocks.getWorkOS).not.toHaveBeenCalled();
		expect(mocks.setCookie).not.toHaveBeenCalled();
	});
});
