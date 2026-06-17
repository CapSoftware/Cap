import { loadSettings } from "./storage";

export const PAGE_NAV_LINKS = [
	{ id: "welcome", label: "Welcome", href: "welcome.html" },
	{ id: "how-it-works", label: "How it works", href: "how-it-works.html" },
	{ id: "camera", label: "Camera access", href: "camera-permission.html" },
	{ id: "options", label: "Options", href: "options.html" },
] as const;

export type PageNavId = (typeof PAGE_NAV_LINKS)[number]["id"];

const DEFAULT_DASHBOARD_URL =
	import.meta.env.MODE === "development"
		? "http://localhost:3000/dashboard"
		: "https://cap.so/dashboard";

const CAP_LOGO_SVG = `<svg class="page-nav-logo" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 103 40" aria-hidden="true"><path fill="#4785FF" d="M20 36c8.837 0 16-7.163 16-16S28.837 4 20 4 4 11.164 4 20s7.164 16 16 16"/><path fill="#ADC9FF" d="M20 33c7.18 0 13-5.82 13-13S27.18 7 20 7 7 12.82 7 20s5.82 13 13 13"/><path fill="#fff" d="M20 30c5.523 0 10-4.477 10-10s-4.477-10-10-10-10 4.477-10 10 4.477 10 10 10"/><path fill="currentColor" d="M58.416 30.448c-5.404 0-9.212-3.864-9.212-10.36 0-6.384 3.668-10.416 9.268-10.416 5.068 0 7.784 2.66 8.624 7.168l-3.808.196c-.476-2.604-2.072-4.2-4.816-4.2-3.388 0-5.488 2.828-5.488 7.252 0 4.48 2.156 7.196 5.46 7.196 2.94 0 4.508-1.708 4.956-4.564l3.808.196c-.784 4.676-3.752 7.532-8.792 7.532m16.23-.112c-3.137 0-5.209-1.484-5.209-4.088 0-2.576 1.596-3.948 4.872-4.592l4.956-.98c0-2.1-.98-3.192-2.856-3.192-1.764 0-2.716.812-3.052 2.324l-3.668-.168c.588-3.136 2.996-4.928 6.72-4.928 4.256 0 6.44 2.24 6.44 6.216v5.432c0 .812.28 1.036.84 1.036h.476V30c-.224.056-.812.112-1.288.112-1.624 0-2.828-.588-3.136-2.436-.728 1.596-2.632 2.66-5.096 2.66m.727-2.604c2.38 0 3.892-1.512 3.892-3.78v-.84l-3.864.784c-1.596.308-2.24.98-2.24 2.016 0 1.176.784 1.82 2.212 1.82M86.874 34.2V15.048h3.444l.056 2.212c.868-1.652 2.52-2.548 4.48-2.548 4.256 0 6.356 3.5 6.356 7.812s-2.128 7.812-6.384 7.812c-1.904 0-3.556-.924-4.368-2.38V34.2zm7.112-6.776c2.184 0 3.5-1.82 3.5-4.9s-1.316-4.9-3.5-4.9-3.528 1.652-3.528 4.9 1.316 4.9 3.528 4.9"/></svg>`;

export const mountPageNav = (active: PageNavId) => {
	if (document.querySelector(".page-nav")) return;

	const nav = document.createElement("nav");
	nav.className = "page-nav";
	nav.setAttribute("aria-label", "Cap extension pages");

	const inner = document.createElement("div");
	inner.className = "page-nav-inner";

	const brand = document.createElement("a");
	brand.className = "page-nav-brand";
	brand.href = "welcome.html";
	brand.setAttribute("aria-label", "Cap");
	brand.innerHTML = CAP_LOGO_SVG;

	const links = document.createElement("div");
	links.className = "page-nav-links";
	for (const link of PAGE_NAV_LINKS) {
		const anchor = document.createElement("a");
		anchor.className =
			link.id === active ? "page-nav-link is-active" : "page-nav-link";
		anchor.href = link.href;
		anchor.textContent = link.label;
		if (link.id === active) {
			anchor.setAttribute("aria-current", "page");
		}
		links.append(anchor);
	}

	const dashboard = document.createElement("a");
	dashboard.className = "page-nav-link";
	dashboard.href = DEFAULT_DASHBOARD_URL;
	dashboard.target = "_blank";
	dashboard.rel = "noopener";
	dashboard.textContent = "Dashboard";
	links.append(dashboard);
	// The user may point the extension at a self-hosted instance, so resolve
	// the real base URL once settings load and leave the default until then.
	void loadSettings()
		.then((settings) => {
			dashboard.href = new URL("/dashboard", settings.apiBaseUrl).toString();
		})
		.catch(() => undefined);

	inner.append(brand, links);
	nav.append(inner);
	document.body.prepend(nav);
};
