import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
	catalogPath,
	marketingEmails,
	renderCatalog,
	validateCatalog,
} from "./catalog";

const { values } = parseArgs({
	options: { check: { type: "boolean", default: false } },
});
const errors = await validateCatalog();
if (errors.length) throw new Error(errors.join("\n"));
const content = renderCatalog();
if (values.check) {
	const saved = await readFile(catalogPath, "utf8").catch(() => "");
	if (saved !== content)
		throw new Error("Email catalogue is stale. Run bun run emails:catalog.");
	console.log(
		`Email catalogue, ${marketingEmails.length} marketing messages, variables and application source inventory verified.`,
	);
} else {
	await writeFile(catalogPath, content);
	console.log(`Updated ${catalogPath}`);
}
