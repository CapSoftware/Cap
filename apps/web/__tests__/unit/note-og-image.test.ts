import { Context, Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NOTE_TEXT = "NOTE-TEXT-acquisition-of-initech";

const mocks = vi.hoisted(() => ({
	row: null as Record<string, unknown> | null,
	access: "allowed" as "allowed" | "private" | "password",
	renderVideoOg: vi.fn(async (_variant: unknown) => new Response("card")),
	renderVideoOgStatus: vi.fn(async (_kind: unknown) => new Response("status")),
	storage: vi.fn(),
	posterFrame: vi.fn(),
	tables: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: (table: { [key: symbol]: unknown }) => {
				mocks.tables.push(
					String(
						Object.getOwnPropertySymbols(table)
							.map((symbol) => table[symbol])
							.find((value) => typeof value === "string"),
					),
				);
				return {
					leftJoin: () => ({
						where: async () => (mocks.row ? [mocks.row] : []),
					}),
				};
			},
		}),
	}),
}));
vi.mock("@cap/web-backend", () => ({
	findScreenshotObjectKey: () => null,
	Storage: { getAccessForVideo: mocks.storage },
	VideosPolicy: Context.GenericTag("NoteOgPolicy"),
}));
vi.mock("@/lib/og/poster-frame", () => ({
	extractPosterFrameDataUri: mocks.posterFrame,
}));
vi.mock("@/lib/og/video-og", () => ({
	renderVideoOg: mocks.renderVideoOg,
	renderVideoOgStatus: mocks.renderVideoOgStatus,
}));
vi.mock("@/lib/video-storage", () => ({ decodeStorageVideo: vi.fn() }));
vi.mock("@/lib/server", () => {
	const policy = {
		canViewLoaded: () =>
			mocks.access === "allowed"
				? Effect.void
				: Effect.fail({
						_tag:
							mocks.access === "private"
								? "PolicyDenied"
								: "VerifyVideoPasswordError",
					}),
	};
	const provide = <A, E>(effect: Effect.Effect<A, E, unknown>) =>
		effect.pipe(
			Effect.provideService(Context.GenericTag("NoteOgPolicy"), policy),
		) as Effect.Effect<A, E>;
	return {
		runPromise: <A, E>(effect: Effect.Effect<A, E, unknown>) =>
			Effect.runPromise(provide(effect)),
		runPromiseExit: <A, E>(effect: Effect.Effect<A, E, unknown>) =>
			Effect.runPromiseExit(provide(effect)),
	};
});

const { generateVideoOgImage } = await import("@/actions/videos/get-og-image");

const note = (overrides: Record<string, unknown> = {}) => ({
	video: {
		id: "note-1",
		ownerId: "owner",
		orgId: "org-1",
		name: "Weekly sync",
		public: true,
		password: null,
		isNote: true,
		isScreenshot: false,
		metadata: null,
		source: { type: "local" },
		duration: 1_934,
		...overrides,
	},
	ownerName: "Alex Morgan",
});

beforeEach(() => {
	mocks.access = "allowed";
	mocks.tables = [];
	for (const fn of [
		mocks.renderVideoOg,
		mocks.renderVideoOgStatus,
		mocks.storage,
		mocks.posterFrame,
	])
		fn.mockClear();
});

describe("link preview image for a note", () => {
	it("shows the title and owner of a note anyone can open", async () => {
		mocks.row = note();

		await generateVideoOgImage("note-1" as never);

		expect(mocks.renderVideoOg.mock.calls).toEqual([
			[
				{
					kind: "note",
					note: { title: "Weekly sync", ownerName: "Alex Morgan" },
				},
			],
		]);
		expect(mocks.storage).not.toHaveBeenCalled();
		expect(mocks.posterFrame).not.toHaveBeenCalled();
	});

	it.each([
		["password-protected", { password: "hash" }, "allowed", "password"],
		["private", { public: false }, "allowed", "locked"],
		["restricted", {}, "private", "locked"],
		["space password", {}, "password", "password"],
	] as const)(
		"shows nothing about a %s note",
		async (_name, overrides, access, status) => {
			mocks.row = note({ name: NOTE_TEXT, ...overrides });
			mocks.access = access;

			await generateVideoOgImage("note-1" as never);

			expect(mocks.renderVideoOgStatus.mock.calls).toEqual([[status]]);
			expect(mocks.renderVideoOg).not.toHaveBeenCalled();
		},
	);

	it("never reads note content", async () => {
		mocks.row = note();

		await generateVideoOgImage("note-1" as never);

		expect(mocks.tables).toEqual(["videos"]);
	});
});
