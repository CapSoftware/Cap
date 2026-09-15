import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { contactFallbacks, logo, sender } from "../../emails/brand";
import { mjmlVariables, renderMjml } from "../../emails/mjml";
import { marketingEmails, root, validateCatalog } from "./catalog";

const { values } = parseArgs({ options: { output: { type: "string" } } });
if (!values.output) throw new Error("Pass --output with the export directory");
const errors = await validateCatalog();
if (errors.length) throw new Error(errors.join("\n"));
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const asset = await readFile(new URL(logo.file, root));
const manifest = [];
for (const email of marketingEmails) {
	const temporary = await mkdtemp(join(tmpdir(), "cap-email-"));
	try {
		await mkdir(join(temporary, "img"));
		const mjml = renderMjml(email);
		await writeFile(join(temporary, "index.mjml"), mjml);
		await writeFile(join(temporary, "img/cap-logo.png"), asset);
		const archive = join(temporary, `${email.id}.zip`);
		execFileSync("zip", ["-q", "-r", archive, "index.mjml", "img"], {
			cwd: temporary,
		});
		await copyFile(archive, join(output, `${email.id}.zip`));
		await writeFile(join(output, `${email.id}.mjml`), mjml);
		manifest.push({
			id: email.id,
			file: `${email.id}.zip`,
			sha256: createHash("sha256").update(mjml).update(asset).digest("hex"),
			subject: mjmlVariables(email.subject),
			previewText: mjmlVariables(email.previewText),
			...sender,
			emailFormat: "mjml",
			fallbacks: Object.fromEntries(
				email.variables.map((key) => [key, contactFallbacks[key]]),
			),
		});
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}
await writeFile(
	join(output, "manifest.json"),
	`${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(
	`Exported ${manifest.length} email archives and manifest to ${output}`,
);
