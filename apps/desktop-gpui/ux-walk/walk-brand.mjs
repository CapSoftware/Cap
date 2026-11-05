import fs from "node:fs";

const sources = ["brand.json", "../../../crates/fork-brand/brand.json"];

function readBrand() {
	for (const source of sources) {
		const file = new URL(source, import.meta.url);
		if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
	}
	throw new Error("The walk engine is missing brand.json");
}

const brand = readBrand();

export const walkModeName = brand.walk_mode_name.replaceAll(
	"%app%",
	brand.display_name,
);
