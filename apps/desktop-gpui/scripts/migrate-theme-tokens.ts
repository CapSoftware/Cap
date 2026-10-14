import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../src/", import.meta.url));
const legacy: Record<string, string> = {
	gray_1: "surface",
	gray_2: "surface_secondary",
	gray_3: "surface_subtle",
	gray_4: "hover_bg",
	gray_5: "active_bg",
	gray_6: "border",
	gray_7: "border_strong",
	gray_8: "border_strong",
	gray_9: "text_muted",
	gray_10: "text_secondary",
	gray_11: "text_secondary",
	gray_12: "text_primary",
	gray_200_legacy: "surface_subtle",
	gray_300_legacy: "border",
	gray_400_legacy: "border_strong",
	gray_500_legacy: "text_primary",
	blue_3: "primary_subtle",
	blue_4: "primary_subtle",
	blue_5: "primary_subtle",
	blue_6: "primary_subtle",
	blue_8: "primary_hover",
	blue_9: "primary",
	blue_10: "primary_hover",
	blue_11: "text_interactive",
	blue_12: "text_interactive",
	blue_100: "primary_subtle",
	blue_500: "primary",
	red_2: "negative_subtle",
	red_3: "negative_subtle",
	red_4: "negative_subtle",
	red_9: "danger",
	red_10: "danger_hover",
	red_11: "text_danger",
	red_300: "danger",
	amber_3: "warning_subtle",
	amber_6: "warning",
	amber_11: "text_warning",
};
const editorChrome: Record<string, string> = {
	window: "surface",
	card: "surface_raised",
	card_2: "surface_secondary",
	line: "border_subtle",
	line_strong: "border",
	text_1: "text_primary",
	text_2: "text_secondary",
	text_3: "text_muted",
	ctl: "surface_subtle",
	ctl_hover: "hover_bg",
	ctl_active: "active_bg",
	accent: "primary",
	accent_2: "primary_hover",
};

async function rustFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return rustFiles(path);
			return entry.isFile() &&
				entry.name.endsWith(".rs") &&
				entry.name !== "theme.rs"
				? [path]
				: [];
		}),
	);
	return nested.flat();
}

function radius(value: number): string {
	if (value <= 4) return "Small";
	if (value <= 6.5) return "Compact";
	if (value <= 9) return "Default";
	if (value <= 24) return "Medium";
	return "Large";
}

const files = await rustFiles(source);
const check = process.argv.includes("--check");
let legacyCount = 0;
let radiusCount = 0;
const changed: string[] = [];
for (const file of files) {
	const input = await readFile(file, "utf8");
	const output = input
		.split("\n")
		.map((line) => {
			if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*"))
				return line;
			let next = line.replace(
				/\btheme\.(gray_[\w]+|blue_[\w]+|red_[\w]+|amber_[\w]+)/g,
				(_full, field: string) => {
					const token = legacy[field];
					if (!token) throw new Error(`Unmapped ${field} in ${file}`);
					legacyCount++;
					return `theme.${token}`;
				},
			);
			next = next.replace(
				/\btheme\.editor\.([a-z_0-9]+)/g,
				(full, field: string) => {
					const token = editorChrome[field];
					if (!token) return full;
					legacyCount++;
					return `theme.${token}`;
				},
			);
			next = next.replace(
				/(\.rounded(?:_(?:t|b|l|r|tl|tr|bl|br))?)\(px\((\d+(?:\.\d*)?)\)\)/g,
				(_full, method: string, value: string) => {
					radiusCount++;
					return `${method}(crate::theme::radius(crate::theme::RadiusToken::${radius(Number(value))}))`;
				},
			);
			next = next.replace(/\.rounded_full\(\)/g, () => {
				radiusCount++;
				return ".rounded(crate::theme::radius(crate::theme::RadiusToken::Large))";
			});
			return next;
		})
		.join("\n");
	if (output === input) continue;
	changed.push(file);
	if (!check) await writeFile(file, output);
}
if (check && changed.length)
	throw new Error(`Unmigrated files: ${changed.join(", ")}`);
console.log(
	`${legacyCount} legacy fields and ${radiusCount} literal radii ${check ? "remaining" : "rewritten"} in ${changed.length} files`,
);
