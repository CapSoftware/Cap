import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	isCap: "true" as string | undefined,
	disposable: vi.fn<(email: string) => Promise<boolean>>(),
	results: [] as unknown[][],
	select: vi.fn(),
}));

vi.mock("@cap/env", () => ({
	buildEnv: {
		get NEXT_PUBLIC_IS_CAP() {
			return mocks.isCap;
		},
	},
}));

vi.mock("@cap/database", () => ({
	db: () => ({ select: mocks.select }),
}));

vi.mock("../../../../packages/database/auth/disposable-email", () => ({
	isDisposableEmail: mocks.disposable,
}));

const { isDisposableEmailSignup } = await import(
	"@cap/database/auth/disposable-signup"
);

function queueRows(...rows: unknown[][]) {
	mocks.results = rows;
	mocks.select.mockImplementation(() => ({
		from: () => ({
			where: () => ({ limit: async () => mocks.results.shift() ?? [] }),
		}),
	}));
}

describe("isDisposableEmailSignup", () => {
	beforeEach(() => {
		mocks.isCap = "true";
		mocks.disposable.mockReset();
		mocks.select.mockReset();
	});

	it("allows addresses that are not disposable without touching the database", async () => {
		mocks.disposable.mockResolvedValue(false);
		await expect(isDisposableEmailSignup("a@company.example")).resolves.toBe(
			false,
		);
		expect(mocks.select).not.toHaveBeenCalled();
	});

	it("refuses a new account on a disposable address", async () => {
		mocks.disposable.mockResolvedValue(true);
		queueRows([]);
		await expect(isDisposableEmailSignup("a@throwaway.example")).resolves.toBe(
			true,
		);
	});

	it("lets people who already signed in with the address keep access", async () => {
		mocks.disposable.mockResolvedValue(true);
		queueRows([{ id: "u1", emailVerified: new Date() }]);
		await expect(isDisposableEmailSignup("a@throwaway.example")).resolves.toBe(
			false,
		);

		queueRows([{ id: "u2", emailVerified: null }], [{ userId: "u2" }]);
		await expect(isDisposableEmailSignup("b@throwaway.example")).resolves.toBe(
			false,
		);
	});

	it("lets a guest checkout customer sign in for the first time", async () => {
		mocks.disposable.mockResolvedValue(true);
		queueRows([
			{
				id: "u4",
				emailVerified: null,
				stripeCustomerId: "cus_1",
				stripeSubscriptionId: "sub_1",
			},
		]);
		await expect(isDisposableEmailSignup("d@throwaway.example")).resolves.toBe(
			false,
		);
		expect(mocks.select).toHaveBeenCalledTimes(1);
	});

	it("refuses an invited row that has never signed in even after someone paid for it", async () => {
		mocks.disposable.mockResolvedValue(true);
		queueRows(
			[
				{
					id: "u5",
					emailVerified: null,
					stripeCustomerId: "cus_2",
					stripeSubscriptionId: "sub_2",
					marketingOrigin: "teammate",
				},
			],
			[],
		);
		await expect(isDisposableEmailSignup("e@throwaway.example")).resolves.toBe(
			true,
		);
	});

	it("refuses an invite-provisioned row that has never signed in", async () => {
		mocks.disposable.mockResolvedValue(true);
		queueRows([{ id: "u3", emailVerified: null }], []);
		await expect(isDisposableEmailSignup("c@throwaway.example")).resolves.toBe(
			true,
		);
	});

	it("does nothing outside Cap's hosted service", async () => {
		mocks.isCap = undefined;
		mocks.disposable.mockResolvedValue(true);
		await expect(isDisposableEmailSignup("a@throwaway.example")).resolves.toBe(
			false,
		);
		expect(mocks.disposable).not.toHaveBeenCalled();
	});
});
