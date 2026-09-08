import { Context, Effect } from "effect";
import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type EditUpload = {
	phase: "processing" | "generating_thumbnail" | "complete" | "error";
	updatedAt: Date;
	processingProgress: number;
	rawFileKey: string;
};

const database = vi.hoisted(() => {
	const state: { upload: EditUpload | null } = { upload: null };
	let selection: Record<string, unknown> | undefined;
	const where = vi.fn(async () => {
		if (selection && "editSpec" in selection) return [];
		return [
			{
				id: "video123",
				name: "Long recording",
				ownerId: "owner123",
				owner: { id: "owner123" },
				duration: 2032,
				width: 1920,
				height: 1080,
				source: { type: "desktopMP4" },
				isScreenshot: false,
				password: null,
				organizationTombstoneAt: null,
				...state.upload,
				uploadPhase: state.upload?.phase ?? null,
				hasActiveUpload: Boolean(state.upload),
				activeUploadRawFileKey: state.upload?.rawFileKey ?? null,
			},
		];
	});
	const query = {
		from: () => query,
		leftJoin: () => query,
		innerJoin: () => query,
		where,
	};
	const select = vi.fn((fields?: Record<string, unknown>) => {
		selection = fields;
		return query;
	});
	const remove = vi.fn(() => ({
		where: vi.fn(async () => {
			state.upload = null;
			return [{ affectedRows: 1 }];
		}),
	}));
	return { state, select, remove, insert: vi.fn(), update: vi.fn() };
});

const viewPolicy = Context.GenericTag<{
	canViewLoaded: () => Effect.Effect<void>;
}>("EditNavigationViewPolicy");

vi.mock("@cap/database", () => ({
	db: () => ({
		select: database.select,
		delete: database.remove,
		insert: database.insert,
		update: database.update,
	}),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "owner123", isPro: true }),
}));
vi.mock("@cap/utils", () => ({ userIsPro: () => true }));
vi.mock("@cap/ui", () => ({}));
vi.mock("@cap/web-backend", () => ({
	provideOptionalAuth: <A>(effect: A) => effect,
}));
vi.mock("@cap/web-backend/src/Videos/VideosPolicy", () => ({
	VideosPolicy: viewPolicy,
}));
vi.mock("@/lib/server", () => ({
	runPromise: (
		effect: Effect.Effect<
			unknown,
			unknown,
			Context.Tag.Identifier<typeof viewPolicy>
		>,
	) =>
		Effect.runPromise(
			Effect.provideService(effect, viewPolicy, {
				canViewLoaded: () => Effect.void,
			}),
		),
}));
vi.mock("next/navigation", () => ({
	notFound: () => {
		throw new Error("NEXT_NOT_FOUND");
	},
}));
vi.mock("@/actions/videos/get-analytics", () => ({}));
vi.mock("@/app/(org)/dashboard/dashboard-data", () => ({}));
vi.mock("@/lib/ai/provider", () => ({}));
vi.mock("@/lib/desktop-segments-recovery", () => ({}));
vi.mock("@/lib/Notification", () => ({}));
vi.mock("@/lib/public-share-video", () => ({}));
vi.mock("@/lib/shareable-link-quota", () => ({}));
vi.mock("@/lib/transcribe", () => ({}));
vi.mock("@/utils/flags", () => ({}));
vi.mock("@/app/s/[videoId]/_components/PasswordOverlay", () => ({
	PasswordOverlay: () => null,
}));
vi.mock("@/app/s/[videoId]/_components/PendingRecordingShare", () => ({}));
vi.mock("@/app/s/[videoId]/_components/ShareHeader", () => ({}));
vi.mock("@/app/s/[videoId]/Share", () => ({}));
vi.mock("@/app/s/[videoId]/edit/EditUpgradeGate", () => ({}));
vi.mock("@/app/s/[videoId]/edit/EditVideoClient", () => ({
	EditVideoClient: () => null,
}));
vi.mock("@/app/s/[videoId]/edit/edit-recovery", () => ({
	EditRecovery: () => null,
}));

describe("viewing a recording during an edit", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		database.state.upload = null;
	});

	it.each([
		["processing", 15],
		["generating_thumbnail", 90],
		["complete", 100],
		["error", 15],
	] as const)(
		"preserves an old %s edit while rendering the share and edit pages",
		async (phase, processingProgress) => {
			const upload: EditUpload = {
				phase,
				processingProgress,
				updatedAt: new Date(Date.now() - 60 * 60 * 1000),
				rawFileKey: "owner123/video123/source/original.mp4",
			};
			database.state.upload = upload;
			const { default: ShareVideoPage } = await import(
				"@/app/s/[videoId]/page"
			);
			const share = await ShareVideoPage({
				params: Promise.resolve({ videoId: "video123" }),
				searchParams: Promise.resolve({}),
			});
			expect(isValidElement(share)).toBe(true);
			expect(database.state.upload).toBe(upload);

			const { default: EditVideoPage } = await import(
				"@/app/s/[videoId]/edit/page"
			);
			const edit = EditVideoPage({
				params: Promise.resolve({ videoId: "video123" }),
			});
			const element = await edit;
			const { EditRecovery } = await import(
				"@/app/s/[videoId]/edit/edit-recovery"
			);
			expect(isValidElement(element)).toBe(true);
			expect(element.type).toBe(EditRecovery);

			expect(database.state.upload).toBe(upload);
			expect(database.remove).not.toHaveBeenCalled();
			expect(database.insert).not.toHaveBeenCalled();
			expect(database.update).not.toHaveBeenCalled();
		},
	);
});
