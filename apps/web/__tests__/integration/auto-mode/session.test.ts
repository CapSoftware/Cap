import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	serverEnv: vi.fn(() => ({
		DATABASE_URL: "mysql://test@localhost/test",
	})),
}));

const mockInsertValues = vi.fn().mockResolvedValue([]);
const mockSelectResult: unknown[] = [];

vi.mock("@cap/database", () => ({
	db: () => ({
		insert: () => ({
			values: mockInsertValues,
		}),
		select: () => ({
			from: () => ({
				where: vi
					.fn()
					.mockImplementation(() => Promise.resolve(mockSelectResult)),
			}),
		}),
		update: () => ({
			set: () => ({
				where: vi.fn().mockResolvedValue([]),
			}),
		}),
	}),
}));

vi.mock("@cap/database/schema", () => ({
	autoModeSessions: { id: "id", userId: "userId", orgId: "orgId" },
}));

vi.mock("drizzle-orm", () => ({
	eq: vi.fn((field, value) => ({ field, value })),
}));

const mockUser = {
	id: "user-123",
	email: "test@example.com",
	name: "Test User",
	activeOrganizationId: "org-456",
};

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(),
}));

vi.mock("@cap/database/helpers", () => ({
	nanoId: vi.fn(() => "generated-session-id"),
}));

import { getCurrentUser } from "@cap/database/auth/session";
import type { AutoMode, Organisation } from "@cap/web-domain";
import { createAutoModeSession } from "@/actions/auto-mode/create-session";
import {
	getAutoModeSession,
	updateAutoModeQuestionnaire,
} from "@/actions/auto-mode/update-session";

describe("createAutoModeSession", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSelectResult.length = 0;
	});

	describe("authentication", () => {
		it("returns error when user is not authenticated", async () => {
			vi.mocked(getCurrentUser).mockResolvedValue(null);

			const result = await createAutoModeSession({
				orgId: "org-456" as Organisation.OrganisationId,
				prompt: "Record a demo of the login flow",
			});

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.message).toBe("Unauthorized");
			}
		});
	});

	describe("input validation", () => {
		beforeEach(() => {
			vi.mocked(getCurrentUser).mockResolvedValue(
				mockUser as ReturnType<typeof getCurrentUser> extends Promise<infer T>
					? T
					: never,
			);
		});

		it("returns error when prompt is empty", async () => {
			const result = await createAutoModeSession({
				orgId: "org-456" as Organisation.OrganisationId,
				prompt: "",
			});

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.message).toBe("Prompt is required");
			}
		});

		it("returns error when prompt is only whitespace", async () => {
			const result = await createAutoModeSession({
				orgId: "org-456" as Organisation.OrganisationId,
				prompt: "   ",
			});

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.message).toBe("Prompt is required");
			}
		});

		it("returns error when orgId is missing", async () => {
			const result = await createAutoModeSession({
				orgId: "" as Organisation.OrganisationId,
				prompt: "Record a demo",
			});

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.message).toBe("Organization ID is required");
			}
		});
	});

	describe("session creation", () => {
		beforeEach(() => {
			vi.mocked(getCurrentUser).mockResolvedValue(
				mockUser as ReturnType<typeof getCurrentUser> extends Promise<infer T>
					? T
					: never,
			);
		});

		it("creates session with valid input", async () => {
			const result = await createAutoModeSession({
				orgId: "org-456" as Organisation.OrganisationId,
				prompt: "Record a demo of the login flow",
			});

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.sessionId).toBe("generated-session-id");
			}
			expect(mockInsertValues).toHaveBeenCalledTimes(1);
			expect(mockInsertValues).toHaveBeenCalledWith({
				id: "generated-session-id",
				userId: "user-123",
				orgId: "org-456",
				status: "draft",
				prompt: "Record a demo of the login flow",
			});
		});

		it("trims prompt whitespace", async () => {
			await createAutoModeSession({
				orgId: "org-456" as Organisation.OrganisationId,
				prompt: "  Record a demo  ",
			});

			expect(mockInsertValues).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: "Record a demo",
				}),
			);
		});
	});
});

describe("updateAutoModeQuestionnaire", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSelectResult.length = 0;
	});

	describe("authentication", () => {
		it("returns error when user is not authenticated", async () => {
			vi.mocked(getCurrentUser).mockResolvedValue(null);

			const result = await updateAutoModeQuestionnaire({
				sessionId: "session-123" as AutoMode.AutoModeSessionId,
				questionnaire: {
					recordingFocus: "feature_demo",
					keyActions: "Click login button, enter credentials",
					narrationTone: "professional",
					durationPreference: "1min",
				} as AutoMode.AutoModeQuestionnaire,
			});

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.message).toBe("Unauthorized");
			}
		});
	});

	describe("input validation", () => {
		beforeEach(() => {
			vi.mocked(getCurrentUser).mockResolvedValue(
				mockUser as ReturnType<typeof getCurrentUser> extends Promise<infer T>
					? T
					: never,
			);
		});

		it("returns error when sessionId is missing", async () => {
			const result = await updateAutoModeQuestionnaire({
				sessionId: "" as AutoMode.AutoModeSessionId,
				questionnaire: {
					recordingFocus: "feature_demo",
					keyActions: "Click login button",
					narrationTone: "professional",
					durationPreference: "1min",
				} as AutoMode.AutoModeQuestionnaire,
			});

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.message).toBe("Session ID is required");
			}
		});
	});

	describe("session lookup", () => {
		beforeEach(() => {
			vi.mocked(getCurrentUser).mockResolvedValue(
				mockUser as ReturnType<typeof getCurrentUser> extends Promise<infer T>
					? T
					: never,
			);
		});

		it("returns error when session does not exist", async () => {
			mockSelectResult.length = 0;

			const result = await updateAutoModeQuestionnaire({
				sessionId: "nonexistent-session" as AutoMode.AutoModeSessionId,
				questionnaire: {
					recordingFocus: "feature_demo",
					keyActions: "Click login button",
					narrationTone: "professional",
					durationPreference: "1min",
				} as AutoMode.AutoModeQuestionnaire,
			});

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.message).toBe("Session not found");
			}
		});

		it("returns error when user does not own the session", async () => {
			mockSelectResult.push({
				id: "session-123",
				userId: "other-user-456",
				orgId: "org-456",
				status: "draft",
				prompt: "Some prompt",
			});

			const result = await updateAutoModeQuestionnaire({
				sessionId: "session-123" as AutoMode.AutoModeSessionId,
				questionnaire: {
					recordingFocus: "feature_demo",
					keyActions: "Click login button",
					narrationTone: "professional",
					durationPreference: "1min",
				} as AutoMode.AutoModeQuestionnaire,
			});

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.message).toBe(
					"You don't have permission to update this session",
				);
			}
		});
	});

	describe("questionnaire update", () => {
		beforeEach(() => {
			vi.mocked(getCurrentUser).mockResolvedValue(
				mockUser as ReturnType<typeof getCurrentUser> extends Promise<infer T>
					? T
					: never,
			);
			mockSelectResult.push({
				id: "session-123",
				userId: "user-123",
				orgId: "org-456",
				status: "draft",
				prompt: "Some prompt",
			});
		});

		it("updates session with questionnaire answers", async () => {
			const result = await updateAutoModeQuestionnaire({
				sessionId: "session-123" as AutoMode.AutoModeSessionId,
				questionnaire: {
					targetUrl: "https://example.com",
					recordingFocus: "feature_demo",
					keyActions: "Click login button, enter credentials",
					narrationTone: "professional",
					durationPreference: "1min",
					additionalContext: "Focus on the error messages",
				} as AutoMode.AutoModeQuestionnaire,
			});

			expect(result.success).toBe(true);
		});
	});
});

describe("getAutoModeSession", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSelectResult.length = 0;
	});

	describe("authentication", () => {
		it("returns error when user is not authenticated", async () => {
			vi.mocked(getCurrentUser).mockResolvedValue(null);

			const result = await getAutoModeSession(
				"session-123" as AutoMode.AutoModeSessionId,
			);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.message).toBe("Unauthorized");
			}
		});
	});

	describe("input validation", () => {
		beforeEach(() => {
			vi.mocked(getCurrentUser).mockResolvedValue(
				mockUser as ReturnType<typeof getCurrentUser> extends Promise<infer T>
					? T
					: never,
			);
		});

		it("returns error when sessionId is missing", async () => {
			const result = await getAutoModeSession("" as AutoMode.AutoModeSessionId);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.message).toBe("Session ID is required");
			}
		});
	});

	describe("session retrieval", () => {
		beforeEach(() => {
			vi.mocked(getCurrentUser).mockResolvedValue(
				mockUser as ReturnType<typeof getCurrentUser> extends Promise<infer T>
					? T
					: never,
			);
		});

		it("returns error when session does not exist", async () => {
			mockSelectResult.length = 0;

			const result = await getAutoModeSession(
				"nonexistent-session" as AutoMode.AutoModeSessionId,
			);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.message).toBe("Session not found");
			}
		});

		it("returns error when user does not own the session", async () => {
			mockSelectResult.push({
				id: "session-123",
				userId: "other-user-456",
				orgId: "org-456",
				status: "draft",
				prompt: "Some prompt",
			});

			const result = await getAutoModeSession(
				"session-123" as AutoMode.AutoModeSessionId,
			);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.message).toBe(
					"You don't have permission to access this session",
				);
			}
		});

		it("returns session when user owns it", async () => {
			const mockSession = {
				id: "session-123",
				userId: "user-123",
				orgId: "org-456",
				status: "draft",
				prompt: "Record a demo",
				targetUrl: null,
				questionnaire: null,
				generatedPlan: null,
				ttsAudioUrl: null,
				executionLog: null,
				resultVideoId: null,
				errorMessage: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			};
			mockSelectResult.push(mockSession);

			const result = await getAutoModeSession(
				"session-123" as AutoMode.AutoModeSessionId,
			);

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.session.id).toBe("session-123");
				expect(result.session.userId).toBe("user-123");
				expect(result.session.prompt).toBe("Record a demo");
			}
		});
	});
});
