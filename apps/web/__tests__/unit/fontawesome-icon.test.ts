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
});
