import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	user: null as null | { id: string; email: string },
	touched: [] as string[],
}));

vi.mock("@cap/database", () => {
	const touch = (name: string) => () => {
		mocks.touched.push(name);
		throw new Error(`database ${name} reached`);
	};
	return {
		db: () => ({
			select: touch("select"),
			insert: touch("insert"),
			update: touch("update"),
			delete: touch("delete"),
			transaction: touch("transaction"),
		}),
	};
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => mocks.user,
}));
vi.mock("@cap/env", () => ({
	buildEnv: {
		NEXT_PUBLIC_IS_CAP: "true",
		NEXT_PUBLIC_WEB_URL: "https://cap.so",
	},
	serverEnv: () => ({ WEB_URL: "https://cap.so" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@cap/database/crypto", () => ({
	encrypt: async (value: string) => `encrypted:${value}`,
}));
vi.mock("@/lib/developer-key-hash", () => ({
	hashKey: async (value: string) => `hash:${value}`,
}));

const actions: [string, () => Promise<unknown>][] = [
	[
		"create an app",
		async () =>
			(await import("@/actions/developers/create-app")).createDeveloperApp({
				name: "App",
				environment: "development",
			}),
	],
	[
		"update an app",
		async () =>
			(await import("@/actions/developers/update-app")).updateDeveloperApp({
				appId: "app-1",
				name: "Renamed",
			}),
	],
	[
		"delete an app",
		async () =>
			(await import("@/actions/developers/delete-app")).deleteDeveloperApp(
				"app-1",
			),
	],
	[
		"regenerate keys",
		async () =>
			(
				await import("@/actions/developers/regenerate-keys")
			).regenerateDeveloperKeys("app-1"),
	],
	[
		"add a domain",
		async () =>
			(await import("@/actions/developers/add-domain")).addDeveloperDomain(
				"app-1",
				"https://example.com",
			),
	],
	[
		"remove a domain",
		async () =>
			(
				await import("@/actions/developers/remove-domain")
			).removeDeveloperDomain("app-1", "domain-1"),
	],
	[
		"rename a video",
		async () =>
			(await import("@/actions/developers/rename-video")).renameDeveloperVideo(
				"app-1",
				"video-1",
				"Renamed",
			),
	],
	[
		"delete a video",
		async () =>
			(await import("@/actions/developers/delete-video")).deleteDeveloperVideo(
				"app-1",
				"video-1",
			),
	],
];

describe("Cap Infra console actions and the preview list", () => {
	beforeEach(() => {
		mocks.touched = [];
	});

	it.each(actions)(
		"does not let an account outside the preview %s",
		async (_name, run) => {
			mocks.user = { id: "user-1", email: "someone@example.com" };

			await expect(run()).rejects.toThrow("Unauthorized");
			expect(mocks.touched).toEqual([]);
		},
	);

	it.each(actions)(
		"does not let a signed-out visitor %s",
		async (_name, run) => {
			mocks.user = null;

			await expect(run()).rejects.toThrow("Unauthorized");
			expect(mocks.touched).toEqual([]);
		},
	);

	it.each(actions)(
		"lets an account on the preview list through to %s",
		async (_name, run) => {
			mocks.user = { id: "user-1", email: "richie@cap.so" };

			const outcome = await run().then(
				() => "returned",
				(error: unknown) =>
					error instanceof Error ? error.message : String(error),
			);

			expect(outcome).not.toBe("Unauthorized");
			expect(mocks.touched.length).toBeGreaterThan(0);
		},
	);
});
