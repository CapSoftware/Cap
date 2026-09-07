import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => vi.fn());
const whereMock = vi.hoisted(() => vi.fn());
const limitMock = vi.hoisted(() => vi.fn());
const importLoomCsvForUserMock = vi.hoisted(() => vi.fn());
const userIsProMock = vi.hoisted(() => vi.fn(() => true));
const getEffectiveOrganizationRoleMock = vi.hoisted(() => vi.fn());
const canManageOrganizationSettingsMock = vi.hoisted(() => vi.fn());
const mockDb = {
	select: vi.fn(),
	from: vi.fn(),
	leftJoin: vi.fn(),
	innerJoin: vi.fn(),
	where: whereMock,
};

mockDb.select.mockReturnValue(mockDb);
mockDb.from.mockReturnValue(mockDb);
mockDb.leftJoin.mockReturnValue(mockDb);
mockDb.innerJoin.mockReturnValue(mockDb);
whereMock.mockReturnValue({ limit: limitMock });
dbMock.mockReturnValue(mockDb);

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", () => ({ db: dbMock }));
vi.mock("@cap/database/schema", () => ({
	importedVideos: {},
	organizationMembers: {},
	organizations: {},
	users: {},
	videos: {},
}));
vi.mock("@cap/env", () => ({
	serverEnv: vi.fn(() => ({ CAP_VIDEOS_DEFAULT_PUBLIC: true })),
}));
vi.mock("@cap/utils", () => ({ userIsPro: userIsProMock }));
vi.mock("@/lib/loom-import", () => ({
	importLoomCsvForUser: importLoomCsvForUserMock,
}));
vi.mock("@/lib/permissions/roles", () => ({
	canManageOrganizationSettings: canManageOrganizationSettingsMock,
	getEffectiveOrganizationRole: getEffectiveOrganizationRoleMock,
}));

import {
	authorizeExtensionLoomImport,
	canonicalizeExtensionLoomUrl,
	ExtensionLoomAuthorizationError,
	importExtensionLoomRow,
	MAX_EXTENSION_LOOM_ROW_NUMBER,
	validateExtensionLoomRow,
} from "@/lib/extension-loom-import";

const validRow = {
	rowNumber: 1,
	loomUrl: `https://www.loom.com/share/${"a".repeat(32)}`,
	userEmail: "owner@example.com",
};

describe("extension Loom import validation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		limitMock.mockReset();
		importLoomCsvForUserMock.mockReset();
		getEffectiveOrganizationRoleMock.mockReset();
		canManageOrganizationSettingsMock.mockReset();
		dbMock.mockReturnValue(mockDb);
		mockDb.select.mockReturnValue(mockDb);
		mockDb.from.mockReturnValue(mockDb);
		mockDb.leftJoin.mockReturnValue(mockDb);
		mockDb.innerJoin.mockReturnValue(mockDb);
		whereMock.mockReturnValue({ limit: limitMock });
		userIsProMock.mockReturnValue(true);
	});

	it("accepts share links and 32-hex embed links", () => {
		expect(validateExtensionLoomRow(validRow)).toBeUndefined();
		expect(
			validateExtensionLoomRow({
				...validRow,
				loomUrl: `https://loom.com/embed/${"a".repeat(32)}`,
			}),
		).toBeUndefined();
		expect(
			canonicalizeExtensionLoomUrl(
				`HTTPS://WWW.LOOM.COM/EMBED/${"B".repeat(32)}/`,
			),
		).toBe(`https://www.loom.com/share/${"b".repeat(32)}`);
	});

	it("rejects non-canonical Loom hosts and paths", () => {
		for (const loomUrl of [
			"http://www.loom.com/share/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"https://cdn.loom.com/share/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"https://www.loom.com/watch/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"https://www.loom.com/embed/not-32-hex",
			"https://www.loom.com/share//aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		]) {
			expect(validateExtensionLoomRow({ ...validRow, loomUrl })).toBeDefined();
		}
	});

	it("bounds row numbers and CSV fields", () => {
		expect(
			validateExtensionLoomRow({
				...validRow,
				rowNumber: MAX_EXTENSION_LOOM_ROW_NUMBER + 1,
			}),
		).toBeDefined();
		expect(
			validateExtensionLoomRow({
				...validRow,
				userEmail: "owner\u0000@example.com",
			}),
		).toBeDefined();
		expect(
			validateExtensionLoomRow({
				...validRow,
				spaceName: "Sales\nTeam",
			}),
		).toBeDefined();
		expect(
			validateExtensionLoomRow({
				...validRow,
				userEmail: "invalid",
			}),
		).toBeDefined();
		expect(
			validateExtensionLoomRow({
				...validRow,
				spaceName: "x".repeat(256),
			}),
		).toBeDefined();
		expect(
			validateExtensionLoomRow({
				...validRow,
				userEmail: `${"a".repeat(246)}@example.com`,
			}),
		).toBeDefined();
	});
});

describe("extension Loom import authorization and outcomes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		limitMock.mockReset();
		importLoomCsvForUserMock.mockReset();
		getEffectiveOrganizationRoleMock.mockReset();
		canManageOrganizationSettingsMock.mockReset();
		dbMock.mockReturnValue(mockDb);
		mockDb.select.mockReturnValue(mockDb);
		mockDb.from.mockReturnValue(mockDb);
		mockDb.leftJoin.mockReturnValue(mockDb);
		mockDb.innerJoin.mockReturnValue(mockDb);
		whereMock.mockReturnValue({ limit: limitMock });
		userIsProMock.mockReturnValue(true);
	});

	it("rejects missing organizations before any import effect", async () => {
		limitMock.mockResolvedValueOnce([]);

		await expect(
			authorizeExtensionLoomImport({
				userId: "user-1" as never,
				organizationId: "org-1" as never,
			}),
		).rejects.toBeInstanceOf(ExtensionLoomAuthorizationError);
		expect(importLoomCsvForUserMock).not.toHaveBeenCalled();
	});

	it("rejects non-Pro organization administrators", async () => {
		userIsProMock.mockReturnValueOnce(false);
		getEffectiveOrganizationRoleMock.mockReturnValueOnce("admin");
		canManageOrganizationSettingsMock.mockReturnValueOnce(true);
		limitMock.mockResolvedValueOnce([
			{
				user: { id: "user-1", email: "owner@example.com" },
				ownerId: "owner-1",
				memberRole: "admin",
			},
		]);

		await expect(
			authorizeExtensionLoomImport({
				userId: "user-1" as never,
				organizationId: "org-1" as never,
			}),
		).rejects.toBeInstanceOf(ExtensionLoomAuthorizationError);
		expect(importLoomCsvForUserMock).not.toHaveBeenCalled();
	});

	it("rejects Pro organization members", async () => {
		getEffectiveOrganizationRoleMock.mockReturnValueOnce("member");
		canManageOrganizationSettingsMock.mockReturnValueOnce(false);
		limitMock.mockResolvedValueOnce([
			{
				user: { id: "user-1", email: "member@example.com" },
				ownerId: "owner-1",
				memberRole: "member",
			},
		]);

		await expect(
			authorizeExtensionLoomImport({
				userId: "user-1" as never,
				organizationId: "org-1" as never,
			}),
		).rejects.toBeInstanceOf(ExtensionLoomAuthorizationError);
		expect(importLoomCsvForUserMock).not.toHaveBeenCalled();
	});

	it.each(["owner", "admin"])("accepts a Pro organization %s", async (role) => {
		getEffectiveOrganizationRoleMock.mockReturnValueOnce(role);
		canManageOrganizationSettingsMock.mockReturnValue(true);
		limitMock.mockResolvedValue([
			{
				user: { id: "user-1", email: "admin@example.com" },
				ownerId: "owner-1",
				memberRole: "admin",
			},
		]);

		await expect(
			authorizeExtensionLoomImport({
				userId: "user-1" as never,
				organizationId: "org-1" as never,
			}),
		).resolves.toEqual({
			user: { id: "user-1", email: "admin@example.com" },
			isPro: true,
		});
	});

	it("preserves a Space warning after starting the canonical video", async () => {
		limitMock.mockResolvedValueOnce([]);
		const warning = "Import started, but it could not be added to a space.";
		importLoomCsvForUserMock.mockResolvedValueOnce({
			success: true,
			importedCount: 1,
			failedCount: 0,
			results: [{ success: true, videoId: "video-started", error: warning }],
		});

		const result = await importExtensionLoomRow({
			organizationId: "org-1" as never,
			row: {
				...validRow,
				loomUrl: `https://loom.com/EMBED/${"A".repeat(32)}/?source=fixture`,
				spaceName: "Team knowledge",
			},
			user: { id: "user-1" } as never,
		});

		expect(result).toEqual({
			success: true,
			videoId: "video-started",
			error: warning,
		});
		expect(importLoomCsvForUserMock).toHaveBeenCalledWith(
			expect.objectContaining({
				rows: [{ ...validRow, spaceName: "Team knowledge" }],
			}),
		);
	});

	it("returns an existing video without provisioning or restarting it", async () => {
		limitMock.mockResolvedValueOnce([{ videoId: "video-existing" }]);

		const result = await importExtensionLoomRow({
			organizationId: "org-1" as never,
			row: validRow,
			user: { id: "user-1" } as never,
		});

		expect(result).toEqual({
			success: true,
			videoId: "video-existing",
			error: "Already imported; owner and Space membership are unchanged.",
			existing: true,
		});
		expect(importLoomCsvForUserMock).not.toHaveBeenCalled();
	});

	it("surfaces unknown workflow-start outcomes without private errors", async () => {
		limitMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
		importLoomCsvForUserMock.mockResolvedValueOnce({
			success: false,
			results: [
				{
					rowNumber: 1,
					userEmail: validRow.userEmail,
					success: false,
					error: "Failed to start this import.",
				},
			],
			importedCount: 0,
			failedCount: 1,
		});

		const result = await importExtensionLoomRow({
			organizationId: "org-1" as never,
			row: validRow,
			user: { id: "user-1" } as never,
		});

		expect(result).toEqual({
			success: false,
			error:
				"Import status is unknown. Check your Cap library before retrying.",
			uncertain: true,
		});
	});

	it("keeps persisted sources uncertain when workflow start fails", async () => {
		limitMock
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ videoId: "video-persisted" }]);
		importLoomCsvForUserMock.mockResolvedValueOnce({
			success: false,
			results: [
				{
					rowNumber: 1,
					userEmail: validRow.userEmail,
					success: false,
					error: "Failed to start this import.",
				},
			],
			importedCount: 0,
			failedCount: 1,
		});

		const result = await importExtensionLoomRow({
			organizationId: "org-1" as never,
			row: validRow,
			user: { id: "user-1" } as never,
		});

		expect(result).toEqual({
			success: false,
			videoId: "video-persisted",
			error:
				"Import status is unknown. Check your Cap library before retrying.",
			uncertain: true,
		});
	});
});
