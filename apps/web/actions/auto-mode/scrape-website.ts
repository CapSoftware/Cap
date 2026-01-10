"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { autoModeSessions } from "@cap/database/schema";
import type { AutoMode } from "@cap/web-domain";
import { eq } from "drizzle-orm";

export interface ScrapeWebsiteInput {
	sessionId: AutoMode.AutoModeSessionId;
	url: string;
}

export interface ScrapeWebsiteResult {
	success: true;
	context: {
		url: string;
		title: string;
		metaDescription: string;
		navigation: { label: string; href: string }[];
		headings: { level: number; text: string }[];
		mainContent: string;
		interactiveElements: {
			type: "button" | "input" | "link" | "select" | "textarea";
			label: string;
			selector: string;
			placeholder?: string;
		}[];
		scrapedAt: string;
	};
}

export interface ScrapeWebsiteError {
	success: false;
	message: string;
	code?:
		| "TIMEOUT"
		| "NAVIGATION_FAILED"
		| "BLOCKED"
		| "INVALID_URL"
		| "UNKNOWN";
}

export type ScrapeWebsiteResponse = ScrapeWebsiteResult | ScrapeWebsiteError;

function isValidUrl(urlString: string): boolean {
	try {
		const url = new URL(urlString);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

export async function scrapeWebsiteForSession(
	input: ScrapeWebsiteInput,
): Promise<ScrapeWebsiteResponse> {
	const user = await getCurrentUser();

	if (!user) {
		return { success: false, message: "Unauthorized" };
	}

	if (!input.sessionId) {
		return { success: false, message: "Session ID is required" };
	}

	if (!input.url) {
		return { success: false, message: "URL is required" };
	}

	if (!isValidUrl(input.url)) {
		return {
			success: false,
			message: "Invalid URL format. URL must use http or https protocol.",
			code: "INVALID_URL",
		};
	}

	const [session] = await db()
		.select()
		.from(autoModeSessions)
		.where(eq(autoModeSessions.id, input.sessionId));

	if (!session) {
		return { success: false, message: "Session not found" };
	}

	if (session.userId !== user.id) {
		return {
			success: false,
			message: "You don't have permission to update this session",
		};
	}

	const { scrapeWebsite } = await import("@/lib/scraper");

	const scrapeResult = await scrapeWebsite(input.url, {
		timeout: 30000,
		maxContentLength: 5000,
	});

	if (!scrapeResult.success) {
		return {
			success: false,
			message: scrapeResult.error.message,
			code: scrapeResult.error.code,
		};
	}

	const scrapedContext = {
		url: scrapeResult.context.url,
		title: scrapeResult.context.title,
		metaDescription: scrapeResult.context.metaDescription,
		navigation: scrapeResult.context.navigation,
		headings: scrapeResult.context.headings,
		mainContent: scrapeResult.context.mainContent,
		interactiveElements: scrapeResult.context.interactiveElements,
		scrapedAt: scrapeResult.context.scrapedAt,
	};

	await db()
		.update(autoModeSessions)
		.set({
			scrapedContext,
			targetUrl: input.url,
		})
		.where(eq(autoModeSessions.id, input.sessionId));

	return {
		success: true,
		context: scrapedContext,
	};
}
