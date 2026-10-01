import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { googleChromeScreenRecorderContent } from "@/components/pages/seo/GoogleChromeScreenRecorderPage";
import { SeoPageTemplate } from "@/components/seo/SeoPageTemplate";
import type { SeoPageContent } from "@/components/seo/types";
import { seoPages } from "@/lib/seo-pages";

vi.mock("@cap/ui", async () => {
	const { createElement } = await import("react");
	return {
		Button: ({ children }: { children?: React.ReactNode }) =>
			createElement("button", { type: "button" }, children),
	};
});

const demoSource =
	"https://www.rend.so/embed/10512af0-b922-4efa-8974-f8f14fc1886a?accent=3e63dd";
const repairedSlugs = [
	"screen-recorder-mac",
	"screen-recorder-windows",
	"free-screen-recorder",
	"screen-recording-software",
	"loom-alternative",
	"solutions/agencies",
	"solutions/daily-standup-software",
	"solutions/employee-onboarding-platform",
	"solutions/online-classroom-tools",
	"solutions/remote-team-collaboration",
];
const pagesDirectory = join(process.cwd(), "components/pages");
const pageFiles = readdirSync(pagesDirectory, {
	recursive: true,
	encoding: "utf8",
}).filter((file) => /\.[jt]sx?$/.test(file));

const renderDemo = (video: SeoPageContent["video"], showVideo = true) => {
	const page = seoPages["screen-recorder"];
	if (!page) throw new Error("Missing screen-recorder landing page");
	return new JSDOM(
		renderToStaticMarkup(
			createElement(SeoPageTemplate, {
				content: { ...page.content, video },
				showVideo,
			}),
		),
	);
};

describe("landing page demo videos", () => {
	it.each(repairedSlugs)("%s uses the public inline demo", (slug) => {
		expect(seoPages[slug]?.content.video).toEqual({
			iframe: { src: demoSource, title: "Cap screen recording demo" },
		});
	});

	it("has no missing local video or poster files on landing pages", () => {
		expect(pageFiles.length).toBeGreaterThan(0);
		for (const file of pageFiles) {
			const source = readFileSync(join(pagesDirectory, file), "utf8");
			for (const match of source.matchAll(/["'`](\/videos\/[^"'`]+)["'`]/g)) {
				const path = match[1];
				if (!path) continue;
				expect(
					existsSync(join(process.cwd(), "public", path)),
					`${file} references missing public asset ${path}`,
				).toBe(true);
			}
		}
	});

	it("renders an accessible inline embed with fullscreen and picture-in-picture", () => {
		const dom = renderDemo({
			iframe: { src: demoSource, title: "Cap screen recording demo" },
		});
		try {
			const frames = dom.window.document.querySelectorAll("iframe");
			expect(frames).toHaveLength(1);
			expect(frames[0]?.getAttribute("src")).toBe(demoSource);
			expect(frames[0]?.getAttribute("title")).toBe(
				"Cap screen recording demo",
			);
			expect(frames[0]?.getAttribute("allow")).toBe(
				"fullscreen; picture-in-picture",
			);
			expect(frames[0]?.hasAttribute("allowfullscreen")).toBe(true);
			expect(new URL(frames[0]?.src ?? "").searchParams.has("autoplay")).toBe(
				false,
			);
		} finally {
			dom.window.close();
		}
	});

	it("keeps explicitly hidden demos out of the page", () => {
		const dom = renderDemo({ iframe: { src: demoSource } }, false);
		try {
			expect(dom.window.document.querySelector("iframe")).toBeNull();
			expect(dom.window.document.body.textContent).not.toContain(
				"See Cap in Action",
			);
		} finally {
			dom.window.close();
		}
	});

	it("omits the Chrome demo section until it has a video source", () => {
		const dom = renderDemo(googleChromeScreenRecorderContent.video);
		try {
			expect(dom.window.document.querySelector("iframe")).toBeNull();
			expect(dom.window.document.body.textContent).not.toContain(
				"See the Cap Chrome Extension in Action",
			);
		} finally {
			dom.window.close();
		}
	});

	it.each([{}, { iframe: { src: "" } }])(
		"omits demo headings and players for an empty source: %j",
		(video) => {
			const dom = renderDemo(video);
			try {
				expect(dom.window.document.querySelector("iframe")).toBeNull();
				expect(dom.window.document.body.textContent).not.toContain(
					"See Cap in Action",
				);
			} finally {
				dom.window.close();
			}
		},
	);

	it("retains the existing URL-backed player", () => {
		const dom = renderDemo({ url: demoSource, alt: "Cap demo" });
		try {
			const frame = dom.window.document.querySelector("iframe");
			expect(frame?.getAttribute("src")).toBe(demoSource);
			expect(frame?.getAttribute("title")).toBe("Cap demo");
		} finally {
			dom.window.close();
		}
	});
});
