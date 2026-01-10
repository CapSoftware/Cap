import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	serverEnv: vi.fn(() => ({
		DATABASE_URL: "mysql://test@localhost/test",
	})),
}));

const mockUpdateSet = vi.fn(() => ({
	where: vi.fn().mockResolvedValue([]),
}));
const mockSelectResult: unknown[] = [];

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: vi
					.fn()
					.mockImplementation(() => Promise.resolve(mockSelectResult)),
			}),
		}),
		update: () => ({
			set: mockUpdateSet,
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

const mockScrapeWebsite = vi.fn();

vi.mock("@/lib/scraper", () => ({
	scrapeWebsite: (...args: unknown[]) => mockScrapeWebsite(...args),
}));

import { getCurrentUser } from "@cap/database/auth/session";
import type { AutoMode } from "@cap/web-domain";
import {
	blockedErrorResponse,
	successfulScrapeResponse,
	timeoutErrorResponse,
} from "../../fixtures/auto-mode/scraper-responses";
import { scrapeWebsiteForSession } from "@/actions/auto-mode/scrape-website";

describe("scrapeWebsiteForSession", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSelectResult.length = 0;
	});

	describe("authentication", () => {
		it("returns error when user is not authenticated", async () => {
			vi.mocked(getCurrentUser).mockResolvedValue(null);

			const result = await scrapeWebsiteForSession({
				sessionId: "session-123" as AutoMode.AutoModeSessionId,
				url: "https://example.com",
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
			const result = await scrapeWebsiteForSession({
				sessionId: "" as AutoMode.AutoModeSessionId,
				url: "https://example.com",
			});

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.message).toBe("Session ID is required");
			}
		});

		it("returns error when URL is missing", async () => {
			const result = await scrapeWebsiteForSession({
				sessionId: "session-123" as AutoMode.AutoModeSessionId,
				url: "",
			});

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.message).toBe("URL is required");
			}
		});

		it("returns error when URL is invalid", async () => {
			const result = await scrapeWebsiteForSession({
				sessionId: "session-123" as AutoMode.AutoModeSessionId,
				url: "not-a-valid-url",
			});

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.message).toBe(
					"Invalid URL format. URL must use http or https protocol.",
				);
				expect(result.code).toBe("INVALID_URL");
			}
		});

		it("returns error when URL uses non-http protocol", async () => {
			const result = await scrapeWebsiteForSession({
				sessionId: "session-123" as AutoMode.AutoModeSessionId,
				url: "ftp://example.com",
			});

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.code).toBe("INVALID_URL");
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

			const result = await scrapeWebsiteForSession({
				sessionId: "nonexistent-session" as AutoMode.AutoModeSessionId,
				url: "https://example.com",
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

			const result = await scrapeWebsiteForSession({
				sessionId: "session-123" as AutoMode.AutoModeSessionId,
				url: "https://example.com",
			});

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.message).toBe(
					"You don't have permission to update this session",
				);
			}
		});
	});

	describe("successful scraping", () => {
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
				prompt: "Record a demo",
			});
		});

		it("scrapes website and returns context", async () => {
			mockScrapeWebsite.mockResolvedValue(successfulScrapeResponse);

			const result = await scrapeWebsiteForSession({
				sessionId: "session-123" as AutoMode.AutoModeSessionId,
				url: "https://example.com/dashboard",
			});

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.context.url).toBe("https://example.com/dashboard");
				expect(result.context.title).toBe("Dashboard - Example App");
				expect(result.context.navigation).toHaveLength(4);
				expect(result.context.headings).toHaveLength(4);
				expect(result.context.interactiveElements).toHaveLength(4);
			}
		});

		it("calls scraper with correct options", async () => {
			mockScrapeWebsite.mockResolvedValue(successfulScrapeResponse);

			await scrapeWebsiteForSession({
				sessionId: "session-123" as AutoMode.AutoModeSessionId,
				url: "https://example.com",
			});

			expect(mockScrapeWebsite).toHaveBeenCalledWith("https://example.com", {
				timeout: 30000,
				maxContentLength: 5000,
			});
		});

		it("updates session with scraped context", async () => {
			mockScrapeWebsite.mockResolvedValue(successfulScrapeResponse);

			await scrapeWebsiteForSession({
				sessionId: "session-123" as AutoMode.AutoModeSessionId,
				url: "https://example.com/dashboard",
			});

			expect(mockUpdateSet).toHaveBeenCalledWith(
				expect.objectContaining({
					targetUrl: "https://example.com/dashboard",
					scrapedContext: expect.objectContaining({
						url: "https://example.com/dashboard",
						title: "Dashboard - Example App",
					}),
				}),
			);
		});
	});

	describe("scraper errors", () => {
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
				prompt: "Record a demo",
			});
		});

		it("handles timeout errors from scraper", async () => {
			mockScrapeWebsite.mockResolvedValue(timeoutErrorResponse);

			const result = await scrapeWebsiteForSession({
				sessionId: "session-123" as AutoMode.AutoModeSessionId,
				url: "https://slow-website.com",
			});

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.code).toBe("TIMEOUT");
				expect(result.message).toBe("Page load timed out after 30000ms");
			}
		});

		it("handles blocked errors from scraper", async () => {
			mockScrapeWebsite.mockResolvedValue(blockedErrorResponse);

			const result = await scrapeWebsiteForSession({
				sessionId: "session-123" as AutoMode.AutoModeSessionId,
				url: "https://protected-website.com",
			});

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.code).toBe("BLOCKED");
				expect(result.message).toBe("Access blocked with status 403");
			}
		});

		it("does not update session when scraping fails", async () => {
			mockScrapeWebsite.mockResolvedValue(timeoutErrorResponse);

			await scrapeWebsiteForSession({
				sessionId: "session-123" as AutoMode.AutoModeSessionId,
				url: "https://slow-website.com",
			});

			expect(mockUpdateSet).not.toHaveBeenCalled();
		});
	});
});
