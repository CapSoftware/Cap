import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	user: null as null | { id: string; email: string },
	selects: [] as Record<string, unknown>[][],
	sets: [] as Record<string, unknown>[],
	inserts: [] as Record<string, unknown>[],
	admission: vi.fn(),
	createSession: vi.fn(),
	detach: vi.fn(),
	ensureCustomer: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: () => {
		const rows = () => Promise.resolve(mocks.selects.shift() ?? []);
		const chain = {
			select: () => chain,
			from: () => chain,
			innerJoin: () => chain,
			where: () => chain,
			limit: rows,
			update: () => ({
				set: (values: Record<string, unknown>) => ({
					where: async () => {
						mocks.sets.push(values);
					},
				}),
			}),
			insert: () => ({
				values: async (values: Record<string, unknown>) => {
					mocks.inserts.push(values);
				},
			}),
		};
		return chain;
	},
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => mocks.user,
}));
vi.mock("@cap/database/helpers", () => ({ nanoId: () => "video-1" }));
vi.mock("@cap/database/schema", () => ({
	developerApps: { id: "id", ownerId: "ownerId", deletedAt: "deletedAt" },
	developerCreditAccounts: { id: "id", appId: "appId" },
	developerCreditTransactions: {},
	developerVideos: {},
	users: { id: "id", stripeCustomerId: "stripeCustomerId" },
}));
vi.mock("drizzle-orm", () => ({
	and: (...args: unknown[]) => args,
	eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
	isNull: (a: unknown) => ({ isNull: a }),
}));
vi.mock("@cap/env", () => ({
	buildEnv: {
		NEXT_PUBLIC_IS_CAP: "true",
		NEXT_PUBLIC_WEB_URL: "https://cap.test",
	},
	serverEnv: () => ({
		WEB_URL: "https://cap.test",
		NEXTAUTH_SECRET: "unit-test-signing-secret",
	}),
}));
vi.mock("@cap/utils", () => ({
	stripe: () => ({
		checkout: { sessions: { create: mocks.createSession } },
		paymentMethods: { detach: mocks.detach },
	}),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@cap/web-backend", () => ({
	provideOptionalAuth: <T>(effect: T) => effect,
	S3Buckets: {},
}));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/developer-video-start", () => ({
	claimDeveloperVideoUpload: vi.fn(),
	releaseDeveloperVideoUpload: vi.fn(),
	startDeveloperVideoProcessing: vi.fn(),
}));
vi.mock("@/lib/developer-stripe-customer", () => ({
	ensureDeveloperStripeCustomer: mocks.ensureCustomer,
}));
vi.mock("@/lib/infra-standing", () => ({
	getInfraUploadAdmission: mocks.admission,
	uploadAdmissionError: (admission: { message: string; reason: string }) => ({
		error: "Insufficient credits",
		code: admission.reason,
		message: admission.message,
	}),
}));
vi.mock("@/lib/infra-auto-top-up", async () => {
	const settings = await vi.importActual<
		typeof import("@/lib/infra-auto-top-up")
	>("@/lib/infra-auto-top-up");
	return { autoTopUpSettingsError: settings.autoTopUpSettingsError };
});
vi.mock("@/app/api/utils", async () => {
	const { createMiddleware } = await import("hono/factory");
	return {
		corsMiddleware: createMiddleware(async (_c, next) => next()),
		withAuth: createMiddleware(async (c, next) => {
			if (!mocks.user) return c.text("User not authenticated", 401);
			c.set("user", mocks.user);
			await next();
		}),
		withDeveloperSecretAuth: createMiddleware(async (c, next) => {
			c.set("developerAppId", "app-1");
			c.set("developerKeyType", "secret");
			await next();
		}),
	};
});

import { removeDeveloperSavedCard } from "@/actions/developers/remove-saved-card";
import { updateDeveloperAutoTopUp } from "@/actions/developers/update-auto-topup";
import { app as uploads } from "@/app/api/developer/v1/[...route]/uploads";
import { createDeveloperCardCheckout } from "@/lib/developer-card-checkout";
import {
	ownsInfraApp,
	presignInfraUploadParts,
} from "@/lib/infra-video-upload";

const preview = { id: "user-1", email: "richie@cap.so" };
const outsider = { id: "user-2", email: "someone@example.com" };

const account = (extra: Record<string, unknown> = {}) => ({
	id: "account-1",
	stripeCustomerId: "cus_1",
	stripePaymentMethodId: "pm_1",
	autoTopUpThresholdMicroCredits: 500_000,
	autoTopUpAmountCents: 2500,
	...extra,
});

const cardCheckout = () =>
	createDeveloperCardCheckout({
		user: mocks.user as never,
		appId: "app-1",
	});

beforeEach(() => {
	mocks.user = preview;
	mocks.selects = [];
	mocks.sets = [];
	mocks.inserts = [];
	mocks.admission.mockReset();
	mocks.createSession.mockReset();
	mocks.createSession.mockResolvedValue({ url: "https://checkout.test/s" });
	mocks.detach.mockReset();
	mocks.detach.mockResolvedValue({});
	mocks.ensureCustomer.mockReset();
	mocks.ensureCustomer.mockResolvedValue("cus_1");
});

describe("creating an upload", () => {
	const create = () =>
		uploads.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Demo" }),
		});

	it("refuses with 402 and the amount needed when the app cannot take an upload", async () => {
		mocks.admission.mockResolvedValue({
			allowed: false,
			reason: "insufficient_credits",
			message: "This app has no credit. Add credits to start uploading.",
		});

		const response = await create();

		expect(response.status).toBe(402);
		await expect(response.json()).resolves.toEqual({
			error: "Insufficient credits",
			code: "insufficient_credits",
			message: "This app has no credit. Add credits to start uploading.",
		});
		expect(mocks.admission).toHaveBeenCalledWith("app-1");
		expect(mocks.inserts).toHaveLength(0);
	});

	it("creates the video for free when the app is admitted", async () => {
		mocks.admission.mockResolvedValue({ allowed: true });

		const response = await create();

		expect(response.status).toBe(200);
		const { data } = await response.json();
		expect(data).toMatchObject({ id: "video-1", videoId: "video-1" });
		expect(Object.keys(data).sort()).toEqual([
			"corsOrigin",
			"embedUrl",
			"expiresAt",
			"id",
			"maxBytes",
			"playbackId",
			"shareUrl",
			"status",
			"token",
			"uploadUrl",
			"videoId",
		]);
		expect(mocks.inserts).toEqual([
			expect.objectContaining({ id: "video-1", appId: "app-1", name: "Demo" }),
		]);
		const playbackId = mocks.inserts[0]?.playbackId;
		expect(typeof playbackId).toBe("string");
		expect(String(playbackId).length).toBeGreaterThan(8);
		expect(data).toMatchObject({
			playbackId,
			shareUrl: `https://cap.test/dev/${playbackId}`,
			embedUrl: `https://cap.test/dev/${playbackId}/embed`,
		});
		expect(mocks.inserts[0]?.maxResolutionTier).toBeTruthy();
	});
});

describe("console upload route", () => {
	it("is refused for an account outside the preview list without reading the app", async () => {
		expect(await ownsInfraApp(outsider as never, "app-1")).toBe(false);
		expect(mocks.selects).toHaveLength(0);
	});

	it("is refused for an app the user does not own and allowed for one they do", async () => {
		mocks.selects = [[], [{ id: "app-1" }]];

		expect(await ownsInfraApp(preview as never, "app-1")).toBe(false);
		expect(await ownsInfraApp(preview as never, "app-1")).toBe(true);
	});

	it("presigns at most 50 parts in one request", async () => {
		const ask = (count: number) =>
			presignInfraUploadParts({
				appId: "app-1",
				videoId: "video-1",
				uploadId: "upload-1",
				partNumbers: Array.from({ length: count }, (_, index) => index + 1),
			});

		expect((await ask(0)).status).toBe(400);
		expect((await ask(51)).status).toBe(400);
	});
});

describe("saving a card", () => {
	it("refuses an account outside the preview list before reaching the payment provider", async () => {
		mocks.user = outsider;

		expect(await cardCheckout()).toEqual({ status: "forbidden" });
		expect(mocks.ensureCustomer).not.toHaveBeenCalled();
		expect(mocks.createSession).not.toHaveBeenCalled();
	});

	it("refuses an app the user does not own", async () => {
		mocks.selects = [[]];

		expect(await cardCheckout()).toEqual({ status: "not_found" });
		expect(mocks.createSession).not.toHaveBeenCalled();
	});

	it("opens a setup checkout that keeps the card for this account", async () => {
		mocks.selects = [[account({ userStripeCustomerId: "cus_user" })]];

		expect(await cardCheckout()).toEqual({
			status: "ok",
			url: "https://checkout.test/s",
		});
		expect(mocks.ensureCustomer).toHaveBeenCalledWith({
			user: { ...preview, stripeCustomerId: "cus_user" },
			account: expect.objectContaining({ id: "account-1" }),
		});
		const metadata = {
			type: "developer_card",
			appId: "app-1",
			accountId: "account-1",
			userId: "user-1",
		};
		expect(mocks.createSession).toHaveBeenCalledWith(
			expect.objectContaining({
				customer: "cus_1",
				mode: "setup",
				payment_method_types: ["card"],
				metadata,
				setup_intent_data: { metadata },
				success_url:
					"https://cap.test/dashboard/infra/app-1/billing?card=saved",
			}),
		);
	});

	it("reports a failure when the payment provider refuses", async () => {
		mocks.selects = [[account()]];
		mocks.createSession.mockRejectedValue(new Error("provider down"));
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(await cardCheckout()).toEqual({ status: "failed" });
		errors.mockRestore();
	});
});

describe("auto top-up settings action", () => {
	const save = (
		extra: Partial<Parameters<typeof updateDeveloperAutoTopUp>[0]> = {},
	) => updateDeveloperAutoTopUp({ appId: "app-1", enabled: true, ...extra });

	it("refuses a signed-out user and an account outside the preview list", async () => {
		mocks.user = null;
		await expect(save()).rejects.toThrow("Unauthorized");
		mocks.user = outsider;
		await expect(save()).rejects.toThrow("Unauthorized");
		expect(mocks.sets).toHaveLength(0);
	});

	it("refuses an app the user does not own", async () => {
		mocks.selects = [[]];

		await expect(save()).rejects.toThrow("App not found");
	});

	it("refuses to switch on without a saved card", async () => {
		mocks.selects = [[account({ stripePaymentMethodId: null })]];

		await expect(save()).resolves.toEqual({
			success: false,
			message: "Save a card before switching auto top-up on",
		});
		expect(mocks.sets).toHaveLength(0);
	});

	it("refuses an amount under $5 or a threshold under $1", async () => {
		mocks.selects = [[account()], [account()]];

		await expect(save({ amountCents: 100 })).resolves.toEqual({
			success: false,
			message: expect.stringContaining("amount"),
		});
		await expect(save({ thresholdMicroCredits: 10 })).resolves.toEqual({
			success: false,
			message: expect.stringContaining("threshold"),
		});
		expect(mocks.sets).toHaveLength(0);
	});

	it("saves the threshold and amount when switched on", async () => {
		mocks.selects = [[account()]];

		await expect(
			save({ thresholdMicroCredits: 2_000_000, amountCents: 5000 }),
		).resolves.toEqual({ success: true });
		expect(mocks.sets).toEqual([
			{
				autoTopUpEnabled: true,
				autoTopUpThresholdMicroCredits: 2_000_000,
				autoTopUpAmountCents: 5000,
			},
		]);
	});

	it("keeps the saved values when only switching on", async () => {
		mocks.selects = [[account()]];

		await save();

		expect(mocks.sets).toEqual([
			{
				autoTopUpEnabled: true,
				autoTopUpThresholdMicroCredits: 500_000,
				autoTopUpAmountCents: 2500,
			},
		]);
	});

	it("switches off without a card or valid values", async () => {
		mocks.selects = [
			[
				account({
					stripePaymentMethodId: null,
					autoTopUpThresholdMicroCredits: 0,
					autoTopUpAmountCents: 0,
				}),
			],
		];

		await save({ enabled: false });

		expect(mocks.sets).toEqual([{ autoTopUpEnabled: false }]);
	});
});

describe("removing a saved card", () => {
	it("refuses an account outside the preview list", async () => {
		mocks.user = outsider;

		await expect(removeDeveloperSavedCard("app-1")).rejects.toThrow(
			"Unauthorized",
		);
		expect(mocks.detach).not.toHaveBeenCalled();
	});

	it("forgets the card, switches auto top-up off and detaches it", async () => {
		mocks.selects = [[account()]];

		await removeDeveloperSavedCard("app-1");

		expect(mocks.sets).toEqual([
			{ stripePaymentMethodId: null, autoTopUpEnabled: false },
		]);
		expect(mocks.detach).toHaveBeenCalledWith("pm_1");
	});
});
