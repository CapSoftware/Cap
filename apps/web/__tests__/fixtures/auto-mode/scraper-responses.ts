import type { ScrapeResponse } from "@/lib/scraper";

export const successfulScrapeResponse: ScrapeResponse = {
	success: true,
	context: {
		url: "https://example.com/dashboard",
		title: "Dashboard - Example App",
		metaDescription:
			"Manage your account and view analytics on the Example App dashboard.",
		navigation: [
			{ label: "Home", href: "/" },
			{ label: "Dashboard", href: "/dashboard" },
			{ label: "Settings", href: "/settings" },
			{ label: "Help", href: "/help" },
		],
		headings: [
			{ level: 1, text: "Welcome to Your Dashboard" },
			{ level: 2, text: "Recent Activity" },
			{ level: 2, text: "Quick Actions" },
			{ level: 3, text: "Create New Project" },
		],
		mainContent:
			"Welcome to Your Dashboard. Here you can manage your projects, view analytics, and configure your account settings. Recent Activity shows your latest actions. Quick Actions let you create new projects and invite team members.",
		interactiveElements: [
			{
				type: "button",
				label: "Create Project",
				selector: "#create-project-btn",
			},
			{ type: "button", label: "Invite Team", selector: ".invite-team-btn" },
			{
				type: "input",
				label: "Search",
				selector: "#search-input",
				placeholder: "Search projects...",
			},
			{ type: "link", label: "View All Projects", selector: "#view-all-link" },
		],
		scrapedAt: "2026-01-10T12:00:00.000Z",
	},
};

export const minimalScrapeResponse: ScrapeResponse = {
	success: true,
	context: {
		url: "https://minimal.example.com",
		title: "Minimal Page",
		metaDescription: "",
		navigation: [],
		headings: [{ level: 1, text: "Hello World" }],
		mainContent: "This is a minimal page with very little content.",
		interactiveElements: [],
		scrapedAt: "2026-01-10T12:00:00.000Z",
	},
};

export const complexSpaResponse: ScrapeResponse = {
	success: true,
	context: {
		url: "https://spa-app.example.com/products",
		title: "Products - SPA Application",
		metaDescription: "Browse our product catalog",
		navigation: [
			{ label: "Products", href: "/products" },
			{ label: "Categories", href: "/categories" },
			{ label: "Cart", href: "/cart" },
			{ label: "Account", href: "/account" },
		],
		headings: [
			{ level: 1, text: "Product Catalog" },
			{ level: 2, text: "Featured Products" },
			{ level: 2, text: "New Arrivals" },
			{ level: 2, text: "Best Sellers" },
		],
		mainContent:
			"Product Catalog. Browse our collection of high-quality products. Use filters to narrow down your search. Add items to your cart and checkout securely. Featured Products include our top picks. New Arrivals show the latest additions. Best Sellers highlight popular items.",
		interactiveElements: [
			{
				type: "input",
				label: "Search products",
				selector: "#product-search",
				placeholder: "Search products...",
			},
			{ type: "select", label: "Category", selector: "#category-filter" },
			{ type: "button", label: "Add to Cart", selector: ".add-to-cart-btn" },
			{ type: "button", label: "Quick View", selector: ".quick-view-btn" },
			{ type: "button", label: "Filter", selector: "#apply-filters" },
			{ type: "link", label: "View Details", selector: ".product-link" },
		],
		scrapedAt: "2026-01-10T12:00:00.000Z",
	},
};

export const timeoutErrorResponse: ScrapeResponse = {
	success: false,
	error: {
		code: "TIMEOUT",
		message: "Page load timed out after 30000ms",
	},
};

export const blockedErrorResponse: ScrapeResponse = {
	success: false,
	error: {
		code: "BLOCKED",
		message: "Access blocked with status 403",
	},
};

export const navigationFailedResponse: ScrapeResponse = {
	success: false,
	error: {
		code: "NAVIGATION_FAILED",
		message: "Failed to navigate to URL",
	},
};

export const invalidUrlResponse: ScrapeResponse = {
	success: false,
	error: {
		code: "INVALID_URL",
		message: "URL must use http or https protocol",
	},
};

export const unknownErrorResponse: ScrapeResponse = {
	success: false,
	error: {
		code: "UNKNOWN",
		message: "An unexpected error occurred while scraping the page",
	},
};
