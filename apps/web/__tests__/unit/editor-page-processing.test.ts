import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	rows: [] as unknown[][],
	user: { id: "owner", email: "richie@mcilroy.co" } as {
		id: string;
		email: string;
	} | null,
	studioEnabled: true,
	pro: true,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => {
			const query = {
				from: () => query,
				leftJoin: () => query,
				where: async () => mocks.rows.shift() ?? [],
			};
			return query;
		},
	}),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => mocks.user,
}));
vi.mock("@cap/database/schema", () => ({
	videos: {},
	videoUploads: {},
	videoEdits: {},
}));
vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));
vi.mock("@cap/utils", () => ({ userIsPro: () => mocks.pro }));
vi.mock("@cap/web-domain", () => ({
	Video: { VideoId: { make: (id: string) => id } },
}));
vi.mock("next/navigation", () => ({
	notFound: () => {
		throw new Error("NOT_FOUND");
	},
	redirect: (url: string) => {
		throw new Error(`REDIRECT:${url}`);
	},
}));
vi.mock("@/lib/web-studio-rollout", () => ({
	isWebStudioEnabledForEmail: () => mocks.studioEnabled,
}));
vi.mock("@/lib/video-edit-processing", () => ({
	getEditSourceKey: (owner: string, video: string) =>
		`${owner}/${video}/source/original.mp4`,
	isEditSourceKey: ({ rawFileKey }: { rawFileKey: string | null }) =>
		rawFileKey === "owner/video/source/original.mp4",
}));
vi.mock("@/lib/video-edits", () => ({
	areEditSpecsEquivalent: () => true,
	createIdentityEditSpec: vi.fn(),
}));
vi.mock("@/app/s/[videoId]/edit/EditProcessing", () => ({
	EditProcessing: () => null,
}));
vi.mock("@/app/s/[videoId]/edit/EditVideoClient", () => ({
	EditVideoClient: () => null,
}));
vi.mock("@/app/s/[videoId]/edit/EditUpgradeGate", () => ({
	EditUpgradeGate: () => null,
}));
vi.mock("@/app/s/[videoId]/edit/edit-recovery", () => ({
	EditRecovery: () => null,
}));
vi.mock("@/app/s/[videoId]/edit/studio/StudioEditorClient", () => ({
	StudioEditorClient: () => null,
}));

import { EditProcessing } from "@/app/s/[videoId]/edit/EditProcessing";
import { EditUpgradeGate } from "@/app/s/[videoId]/edit/EditUpgradeGate";
import { EditVideoClient } from "@/app/s/[videoId]/edit/EditVideoClient";
import { EditRecovery } from "@/app/s/[videoId]/edit/edit-recovery";
import EditPage from "@/app/s/[videoId]/edit/page";
import StudioPage from "@/app/s/[videoId]/edit/studio/page";
import { StudioEditorClient } from "@/app/s/[videoId]/edit/studio/StudioEditorClient";

const params = { params: Promise.resolve({ videoId: "video" }) };
const video = {
	id: "video",
	ownerId: "owner",
	name: "Recording",
	duration: 23,
	isScreenshot: false,
	source: { type: "webMP4" },
	metadata: null,
	uploadPhase: null,
	rawFileKey: "owner/video/raw-upload.webm",
};

beforeEach(() => {
	mocks.rows = [];
	mocks.user = { id: "owner", email: "richie@mcilroy.co" };
	mocks.studioEnabled = true;
	mocks.pro = true;
});

for (const [name, page] of [
	["edit", EditPage],
	["studio", StudioPage],
] as const) {
	describe(`${name} recording readiness`, () => {
		test.each(["uploading", "processing", "generating_thumbnail", "error"])(
			"shows progress instead of a 404 for %s, even without final duration",
			async (uploadPhase) => {
				mocks.rows = [[{ ...video, uploadPhase, duration: null }]];
				const result = await page(params);
				expect(result.type).toBe(EditProcessing);
				expect(result.props.videoId).toBe("video");
			},
		);
		test.each([
			{ ...video, ownerId: "another-owner" },
			{ ...video, isScreenshot: true },
			{ ...video, source: { type: "desktopSegments" } },
			undefined,
		])("does not expose processing state for ineligible media", async (row) => {
			mocks.rows = [row ? [{ ...row, uploadPhase: "processing" }] : []];
			await expect(page(params)).rejects.toThrow("NOT_FOUND");
		});
		test("still requires a signed-in owner", async () => {
			mocks.user = null;
			await expect(page(params)).rejects.toThrow("NOT_FOUND");
		});
		test("keeps legacy edit recovery separate from initial recording processing", async () => {
			mocks.rows = [
				[
					{
						...video,
						uploadPhase: "processing",
						rawFileKey: "owner/video/source/original.mp4",
					},
				],
			];
			expect((await page(params)).type).toBe(EditRecovery);
		});
	});
}

test("completed pilot recordings redirect to Studio", async () => {
	mocks.rows = [[video], []];
	await expect(EditPage(params)).rejects.toThrow(
		"REDIRECT:/s/video/edit/studio",
	);
});

test("completed Studio recordings mount the editor", async () => {
	mocks.rows = [[video], []];
	expect((await StudioPage(params)).type).toBe(StudioEditorClient);
});

test("the existing editor and upgrade gate remain available outside the pilot", async () => {
	mocks.studioEnabled = false;
	mocks.rows = [[video], []];
	expect((await EditPage(params)).type).toBe(EditVideoClient);
	mocks.pro = false;
	mocks.rows = [[video], []];
	expect((await EditPage(params)).type).toBe(EditUpgradeGate);
	await expect(StudioPage(params)).rejects.toThrow("NOT_FOUND");
});
