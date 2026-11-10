import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import * as brandIcons from "@fortawesome/free-brands-svg-icons";
import type { IconDefinition } from "@fortawesome/free-solid-svg-icons";
import * as solidIcons from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon as PackageIcon } from "@fortawesome/react-fontawesome";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";

const isIcon = (value: unknown): value is IconDefinition =>
	typeof value === "object" &&
	value !== null &&
	"iconName" in value &&
	"icon" in value &&
	Array.isArray((value as IconDefinition).icon);

const icons = [
	...Object.values(solidIcons),
	...Object.values(brandIcons),
].filter(isIcon);

const requireModule = createRequire(import.meta.url);

const WEB_ROOT = path.resolve(__dirname, "../..");
const SOURCE_ROOTS = [
	WEB_ROOT,
	path.resolve(WEB_ROOT, "../../packages/ui/src"),
];
const SKIPPED_DIRECTORIES = new Set(["node_modules", "public", "__tests__"]);

function sourceFiles(directories = SOURCE_ROOTS): string[] {
	return directories.flatMap((directory) =>
		readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				return entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)
					? []
					: sourceFiles([full]);
			}
			return /\.tsx?$/.test(entry.name) ? [full] : [];
		}),
	);
}

const PROPS = [
	{},
	{ className: "size-4" },
	{ className: "size-3.5 text-gray-10 transition-transform duration-200 " },
	{ className: " mr-2 animate-spin" },
	{ className: "" },
	{ className: "w-2", style: { fontSize: "12px", color: "red" } },
	{ className: "text-blue-500 size-3.5", "aria-hidden": "true" as const },
];

describe("FontAwesomeIcon", () => {
	it("covers the solid and brand icon sets", () => {
		expect(icons.length).toBeGreaterThan(1500);
		expect(icons.some((icon) => icon.prefix === "fab")).toBe(true);
	});

	it("renders the markup the package renders for every icon", () => {
		const differing: string[] = [];
		for (const icon of icons) {
			for (const props of PROPS) {
				const ours = renderToStaticMarkup(
					createElement(FontAwesomeIcon, { icon, ...props }),
				);
				const theirs = renderToStaticMarkup(
					createElement(PackageIcon, { icon, ...props }),
				);
				if (ours !== theirs && differing.length < 5) {
					differing.push(
						`${icon.prefix} ${icon.iconName} ${JSON.stringify(props)}\n ours:   ${ours.slice(0, 200)}\n theirs: ${theirs.slice(0, 200)}`,
					);
				}
			}
		}
		expect(differing).toEqual([]);
	});

	it("gets the same definition from every per-icon module the app imports as from the package root", () => {
		const packages: Record<string, Record<string, unknown>> = {
			"@fortawesome/free-solid-svg-icons": solidIcons,
			"@fortawesome/free-brands-svg-icons": brandIcons,
		};
		const imported = new Map<string, [packageName: string, name: string]>();
		for (const file of sourceFiles()) {
			for (const [, packageName, name] of readFileSync(file, "utf8").matchAll(
				/"(@fortawesome\/free-(?:solid|brands)-svg-icons)\/(fa[A-Za-z0-9]+)"/g,
			)) {
				if (packageName && name) {
					imported.set(`${packageName}/${name}`, [packageName, name]);
				}
			}
		}
		expect(imported.size).toBeGreaterThan(50);

		const differing = [...imported].filter(
			([specifier, [packageName, name]]) => {
				const fromRoot = packages[packageName]?.[name];
				return (
					!isIcon(fromRoot) ||
					JSON.stringify(requireModule(specifier)[name]) !==
						JSON.stringify(fromRoot)
				);
			},
		);
		expect(differing.map(([specifier]) => specifier)).toEqual([]);
	});
});
