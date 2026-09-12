import { describe, expect, test } from "bun:test";
import { customerCopy } from "../../emails/customer-copy";
import type { LoopsClient } from "../../packages/database/loops/client";
import {
	enrollmentWindow,
	type LifecycleContact,
	type LoopsRuntimeConfig,
	lifecycleUpdate,
	retryDelay,
} from "../../packages/database/loops/lifecycle";
import type { LoopsProfileSource } from "../../packages/database/loops/sources";
import {
	loopsRuntimeConfig,
	syncLoopsContact,
} from "../../packages/database/loops/worker";

const email = "hello+loops-runtime-test@cap.so";
const config: LoopsRuntimeConfig = {
	listId: "test-list",
	enrollmentAfter: new Date("2026-09-11T00:00:00Z"),
	enrollmentEnabled: true,
	allowedEmails: new Set([email]),
};

describe("enrollment fingerprint", () => {
	test("historical accounts stay unchanged when enrollment is enabled or the future cutoff moves", () => {
		const signup = "2026-09-10T10:00:00.000Z";
		const held = enrollmentWindow(signup, {
			...config,
			enrollmentEnabled: false,
		});
		expect(held).toEqual({ recentSignup: false, recentJoin: false });
		expect(enrollmentWindow(signup, config)).toEqual(held);
		expect(
			enrollmentWindow(signup, {
				...config,
				enrollmentAfter: new Date("2026-09-12T00:00:00Z"),
			}),
		).toEqual(held);
	});

	test("eligible signups change when enrollment is disabled or the cutoff crosses their signup", () => {
		const signup = "2026-09-11T10:00:00.000Z";
		expect(enrollmentWindow(signup, config)).toEqual({
			recentSignup: true,
			recentJoin: false,
		});
		expect(
			enrollmentWindow(signup, { ...config, enrollmentEnabled: false }),
		).toEqual({ recentSignup: false, recentJoin: false });
		expect(
			enrollmentWindow(signup, {
				...config,
				enrollmentAfter: new Date("2026-09-11T10:00:00.001Z"),
			}),
		).toEqual({ recentSignup: false, recentJoin: false });
	});

	test("new teammate joins change historical accounts at the exact cutoff", () => {
		const signup = "2026-09-10T10:00:00.000Z";
		const joined = { ...config, teammateJoinedAt: "2026-09-11 00:00:00" };
		expect(enrollmentWindow(signup, joined)).toEqual({
			recentSignup: false,
			recentJoin: true,
		});
		expect(
			enrollmentWindow(signup, { ...joined, enrollmentEnabled: false }),
		).toEqual({ recentSignup: false, recentJoin: false });
	});
});

function fixture(): LoopsProfileSource {
	return {
		input: {
			source: { email },
			user: {
				id: "test-user",
				email,
				name: null,
				lastName: null,
				stripeSubscriptionStatus: null,
				thirdPartyStripeSubscriptionId: null,
				created_at: "2026-09-11T10:00:00Z",
				defaultOrgId: "personal-org",
				marketingOrigin: "independent",
			},
			memberships: [],
			licenses: [],
			invited: false,
			sso: false,
			hasVideo: false,
			hasSharedVideo: false,
			now: new Date("2026-09-11T11:00:00Z"),
		},
		signedUp: true,
		pendingInvite: false,
		stripeCustomerId: "cus_test",
	};
}

function remote(): LifecycleContact {
	return {
		id: "contact-test",
		email,
		userId: null,
		subscribed: true,
		mailingLists: { "test-list": true },
	};
}

function fakeApi(initial: LifecycleContact | undefined) {
	let contact = initial;
	const calls: { path: string; method: string; body: unknown }[] = [];
	const api: LoopsClient = {
		async request<T>(path: string, method = "GET", body?: unknown) {
			calls.push({ path, method, body });
			if (path.startsWith("contacts/find"))
				return (contact ? [contact] : []) as T;
			if (path === "contacts/create")
				contact = { ...remote(), ...(body as Partial<LifecycleContact>) };
			if (path === "contacts/update")
				contact = {
					...remote(),
					...contact,
					...(body as Partial<LifecycleContact>),
				};
			return { success: true, id: "contact-test" } as T;
		},
	};
	return { api, calls, read: () => contact };
}

describe("signup routing", () => {
	test("Stripe import is enriched before entering free onboarding", async () => {
		const fake = fakeApi(remote());
		const update = await syncLoopsContact(
			fake.api,
			fixture(),
			{ syncedEmail: null, lastSyncedAt: null },
			config,
			customerCopy,
		);
		expect(fake.calls.map((call) => call.method)).toEqual(["GET", "PUT"]);
		expect(update).toMatchObject({
			capAudience: "free",
			capLifecycleStage: "free",
			capGreeting: "Hey,",
			capOnboardingEligible: true,
		});
		expect(update).not.toHaveProperty("subscribed");
	});
	test("missing Stripe import is retried without creating a Loops contact", async () => {
		const fake = fakeApi(undefined);
		await expect(
			syncLoopsContact(
				fake.api,
				fixture(),
				{ syncedEmail: null, lastSyncedAt: null },
				config,
				customerCopy,
			),
		).rejects.toThrow("awaiting_stripe_contact");
		expect(fake.calls.every((call) => call.method === "GET")).toBe(true);
	});
	test("Stripe import cannot enroll while signup billing bootstrap is incomplete", async () => {
		const source = fixture();
		source.stripeCustomerId = null;
		const fake = fakeApi(remote());
		await expect(
			syncLoopsContact(
				fake.api,
				source,
				{ syncedEmail: null, lastSyncedAt: null },
				config,
				customerCopy,
			),
		).rejects.toThrow("stripe_signup_not_complete");
		expect(fake.calls).toHaveLength(0);
	});
	test("SSO fallback creates a held teammate before enabling helpful onboarding", async () => {
		const source = fixture();
		source.input.sso = true;
		source.stripeCustomerId = null;
		const fake = fakeApi(undefined);
		await syncLoopsContact(
			fake.api,
			source,
			{ syncedEmail: null, lastSyncedAt: null },
			config,
			customerCopy,
		);
		expect(
			fake.calls.find((call) => call.path === "contacts/create")?.body,
		).toMatchObject({
			capAudience: "teammate",
			capLifecycleEnabled: false,
			capPromotionalEligible: false,
		});
		expect(fake.read()).toMatchObject({
			capAudience: "teammate",
			capLifecycleStage: "teammate",
			capPromotionalEligible: false,
		});
	});
	test("invitation provisioning is held until the recipient signs up and accepts", () => {
		const source = fixture();
		source.input.invited = true;
		source.pendingInvite = true;
		expect(
			lifecycleUpdate(source, remote(), config, customerCopy),
		).toMatchObject({
			capAudience: "teammate",
			capPromotionalEligible: false,
			capLifecycleStage: "idle",
		});
		source.pendingInvite = false;
		source.input.invited = false;
		source.input.user.marketingOrigin = "teammate";
		expect(
			lifecycleUpdate(source, remote(), config, customerCopy),
		).toMatchObject({
			capAudience: "teammate",
			capPromotionalEligible: false,
			capLifecycleStage: "teammate",
		});
	});
	test("a member joining during a free flow can never return to sales after leaving or paying", () => {
		const source = fixture();
		const contact = remote();
		Object.assign(
			contact,
			lifecycleUpdate(source, contact, config, customerCopy),
		);
		source.input.user.marketingOrigin = "teammate";
		Object.assign(
			contact,
			lifecycleUpdate(source, contact, config, customerCopy),
		);
		source.input.user.marketingOrigin = "independent";
		source.input.user.stripeSubscriptionStatus = "active";
		expect(
			lifecycleUpdate(source, contact, config, customerCopy),
		).toMatchObject({
			capAudience: "teammate",
			capPromotionalEligible: false,
			capLifecycleStage: "teammate",
		});
	});
	test("paid customers skip the free sales flow", () => {
		const source = fixture();
		source.input.user.stripeSubscriptionStatus = "active";
		expect(
			lifecycleUpdate(source, remote(), config, customerCopy),
		).toMatchObject({
			capAudience: "customer",
			capPromotionalEligible: false,
			capLifecycleStage: "customer",
		});
	});
});

describe("delivery boundaries", () => {
	test("an existing imported user who accepts a new invite receives only teammate help", () => {
		const source = fixture();
		source.input.user.created_at = "2025-01-01T00:00:00Z";
		source.input.user.marketingOrigin = "teammate";
		const update = lifecycleUpdate(
			source,
			{ ...remote(), capImportedAt: "2026-09-10T00:00:00Z" },
			{ ...config, teammateJoinedAt: "2026-09-11 11:00:00" },
			customerCopy,
		);
		expect(update).toMatchObject({
			capLifecycleStage: "teammate",
			capPromotionalEligible: false,
			capOnboardingEligible: true,
		});
	});
	for (const [name, patch] of [
		["global unsubscribe", { subscribed: false }],
		["removed mailing-list membership", { mailingLists: {} }],
		["list unsubscribe", { mailingLists: { "test-list": false } }],
		["suppression", { capConsent: "suppressed" }],
	] as const)
		test(`${name} survives profile and billing updates`, () => {
			const update = lifecycleUpdate(
				fixture(),
				{ ...remote(), ...patch },
				config,
				customerCopy,
			);
			expect(update.capOnboardingEligible).toBe(false);
			expect(update.capPromotionalEligible).toBe(false);
			expect(update).not.toHaveProperty("subscribed");
			expect(update).not.toHaveProperty("mailingLists");
		});
	test("imports and pre-cutover signups remain held", () => {
		expect(
			lifecycleUpdate(
				fixture(),
				{ ...remote(), capImportedAt: "2026-09-10T00:00:00Z" },
				config,
				customerCopy,
			).capLifecycleStage,
		).toBe("idle");
		const source = fixture();
		source.input.user.created_at = "2026-09-01T00:00:00Z";
		expect(
			lifecycleUpdate(source, remote(), config, customerCopy).capLifecycleStage,
		).toBe("idle");
	});
	test("repeated updates retain the same stage and never resubscribe", () => {
		const contact = remote();
		const source = fixture();
		const first = lifecycleUpdate(source, contact, config, customerCopy);
		Object.assign(contact, first);
		const second = lifecycleUpdate(source, contact, config, customerCopy);
		expect(second.capLifecycleStage).toBe(first.capLifecycleStage);
		expect(second).not.toHaveProperty("subscribed");
	});
	test("removed contacts and different account identities are not recreated or overwritten", async () => {
		const fake = fakeApi(undefined);
		await expect(
			syncLoopsContact(
				fake.api,
				fixture(),
				{ syncedEmail: email, lastSyncedAt: "2026-09-11" },
				config,
				customerCopy,
			),
		).rejects.toThrow("remote_contact_removed");
		expect(() =>
			lifecycleUpdate(
				fixture(),
				{ ...remote(), userId: "someone-else" },
				config,
				customerCopy,
			),
		).toThrow("identity_conflict");
	});
	test("test mode refuses non-owned contacts before any provider request", async () => {
		const source = fixture();
		source.input.source.email = "customer@example.com";
		const fake = fakeApi(remote());
		await expect(
			syncLoopsContact(
				fake.api,
				source,
				{ syncedEmail: null, lastSyncedAt: null },
				config,
				customerCopy,
			),
		).rejects.toThrow("outside_test_allowlist");
		expect(fake.calls).toHaveLength(0);
	});
	test("configuration requires explicit cutover and an allowlist by default", () => {
		expect(() => loopsRuntimeConfig({})).toThrow();
		expect(() =>
			loopsRuntimeConfig({
				LOOPS_MAILING_LIST_ID: "test-list",
				LOOPS_ENROLLMENT_AFTER: "2026-09-11",
			}),
		).toThrow("LOOPS_TEST_EMAILS");
		expect(
			loopsRuntimeConfig({
				LOOPS_MAILING_LIST_ID: "test-list",
				LOOPS_ENROLLMENT_AFTER: "2026-09-11",
				LOOPS_TEST_EMAILS: email,
			}).enrollmentEnabled,
		).toBe(false);
		expect(retryDelay(0)).toBe(30_000);
		expect(retryDelay(100)).toBe(3_600_000);
	});
});
