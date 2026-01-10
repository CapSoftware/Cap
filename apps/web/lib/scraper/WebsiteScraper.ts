import type {
	Heading,
	InteractiveElement,
	NavigationLink,
	ScrapedContext,
	ScrapeOptions,
	ScrapeResponse,
} from "./types";

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_MAX_CONTENT_LENGTH = 5000;

export async function scrapeWebsite(
	url: string,
	options: ScrapeOptions = {},
): Promise<ScrapeResponse> {
	const { chromium } = await import("playwright");

	const {
		timeout = DEFAULT_TIMEOUT,
		waitForSelector,
		maxContentLength = DEFAULT_MAX_CONTENT_LENGTH,
	} = options;

	let browser: import("playwright").Browser | undefined;

	try {
		const parsedUrl = new URL(url);
		if (!["http:", "https:"].includes(parsedUrl.protocol)) {
			return {
				success: false,
				error: {
					code: "INVALID_URL",
					message: "URL must use http or https protocol",
				},
			};
		}

		browser = await chromium.launch({ headless: true });
		const context = await browser.newContext({
			userAgent:
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			viewport: { width: 1280, height: 720 },
		});

		const page = await context.newPage();
		page.setDefaultTimeout(timeout);

		const response = await page.goto(url, {
			waitUntil: "networkidle",
			timeout,
		});

		if (!response) {
			return {
				success: false,
				error: {
					code: "NAVIGATION_FAILED",
					message: "Failed to navigate to URL",
				},
			};
		}

		if (response.status() === 403 || response.status() === 429) {
			return {
				success: false,
				error: {
					code: "BLOCKED",
					message: `Access blocked with status ${response.status()}`,
				},
			};
		}

		if (waitForSelector) {
			await page.waitForSelector(waitForSelector, { timeout });
		}

		const title = await page.title();
		const metaDescription = await page
			.$eval(
				'meta[name="description"]',
				(el) => el.getAttribute("content") || "",
			)
			.catch(() => "");

		const navigation = await extractNavigation(page);
		const headings = await extractHeadings(page);
		const interactiveElements = await extractInteractiveElements(page);
		const mainContent = await extractMainContent(page, maxContentLength);

		const scrapedContext: ScrapedContext = {
			url: page.url(),
			title,
			metaDescription,
			navigation,
			headings,
			mainContent,
			interactiveElements,
			scrapedAt: new Date().toISOString(),
		};

		return {
			success: true,
			context: scrapedContext,
		};
	} catch (error) {
		if (error instanceof Error && error.message.includes("Timeout")) {
			return {
				success: false,
				error: {
					code: "TIMEOUT",
					message: `Page load timed out after ${timeout}ms`,
				},
			};
		}

		return {
			success: false,
			error: {
				code: "UNKNOWN",
				message: error instanceof Error ? error.message : "Unknown error",
			},
		};
	} finally {
		if (browser) {
			await browser.close();
		}
	}
}

async function extractNavigation(
	page: import("playwright").Page,
): Promise<NavigationLink[]> {
	return page.$$eval('nav a, header a, [role="navigation"] a', (links) =>
		links
			.map((link) => ({
				label: link.textContent?.trim() || "",
				href: link.getAttribute("href") || "",
			}))
			.filter((link) => link.label && link.href)
			.slice(0, 20),
	);
}

async function extractHeadings(
	page: import("playwright").Page,
): Promise<Heading[]> {
	return page.$$eval("h1, h2, h3, h4", (headings) =>
		headings
			.map((h) => ({
				level: parseInt(h.tagName.slice(1), 10),
				text: h.textContent?.trim() || "",
			}))
			.filter((h) => h.text)
			.slice(0, 30),
	);
}

async function extractInteractiveElements(
	page: import("playwright").Page,
): Promise<InteractiveElement[]> {
	const elements: InteractiveElement[] = [];

	const buttons = await page.$$eval(
		'button, [role="button"], input[type="submit"]',
		(btns) =>
			btns
				.map((btn, i) => ({
					type: "button" as const,
					label:
						btn.textContent?.trim() ||
						btn.getAttribute("aria-label") ||
						btn.getAttribute("title") ||
						"",
					selector: btn.id
						? `#${btn.id}`
						: btn.className
							? `.${btn.className.split(" ")[0]}`
							: `button:nth-of-type(${i + 1})`,
				}))
				.filter((b) => b.label),
	);
	elements.push(...buttons.slice(0, 15));

	const inputs = await page.$$eval(
		'input:not([type="hidden"]):not([type="submit"]), textarea',
		(fields) =>
			fields.map((field, i) => ({
				type: (field.tagName.toLowerCase() === "textarea"
					? "textarea"
					: "input") as "input" | "textarea",
				label:
					field.getAttribute("placeholder") ||
					field.getAttribute("aria-label") ||
					field.getAttribute("name") ||
					"",
				selector: field.id
					? `#${field.id}`
					: field.getAttribute("name")
						? `[name="${field.getAttribute("name")}"]`
						: `input:nth-of-type(${i + 1})`,
				placeholder: field.getAttribute("placeholder") || undefined,
			})),
	);
	elements.push(...inputs.slice(0, 15));

	const links = await page.$$eval(
		'main a, article a, [role="main"] a',
		(anchors) =>
			anchors
				.map((a, i) => ({
					type: "link" as const,
					label: a.textContent?.trim() || "",
					selector: a.id ? `#${a.id}` : `a:nth-of-type(${i + 1})`,
				}))
				.filter((l) => l.label)
				.slice(0, 10),
	);
	elements.push(...links);

	return elements;
}

async function extractMainContent(
	page: import("playwright").Page,
	maxLength: number,
): Promise<string> {
	const content = await page
		.$eval(
			'main, article, [role="main"], .content, #content',
			(el) => el.textContent || "",
		)
		.catch(async () => {
			return page.$eval("body", (el) => el.textContent || "");
		});

	const cleanedContent = content
		.replace(/\s+/g, " ")
		.replace(/\n+/g, " ")
		.trim();

	if (cleanedContent.length > maxLength) {
		return `${cleanedContent.slice(0, maxLength)}...`;
	}

	return cleanedContent;
}
