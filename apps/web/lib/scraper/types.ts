export interface NavigationLink {
	label: string;
	href: string;
}

export interface Heading {
	level: number;
	text: string;
}

export interface InteractiveElement {
	type: "button" | "input" | "link" | "select" | "textarea";
	label: string;
	selector: string;
	placeholder?: string;
}

export interface ScrapedContext {
	url: string;
	title: string;
	metaDescription: string;
	navigation: NavigationLink[];
	headings: Heading[];
	mainContent: string;
	interactiveElements: InteractiveElement[];
	scrapedAt: string;
}

export interface ScrapeOptions {
	timeout?: number;
	waitForSelector?: string;
	maxContentLength?: number;
}

export interface ScrapeResult {
	success: true;
	context: ScrapedContext;
}

export interface ScrapeError {
	success: false;
	error: {
		code:
			| "TIMEOUT"
			| "NAVIGATION_FAILED"
			| "BLOCKED"
			| "INVALID_URL"
			| "UNKNOWN";
		message: string;
	};
}

export type ScrapeResponse = ScrapeResult | ScrapeError;
