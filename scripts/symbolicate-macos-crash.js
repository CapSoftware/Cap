// populates an unsymbolicated crash report's 'crashed' section with symbols
// reference: https://developer.apple.com/documentation/xcode/adding-identifiable-symbol-names-to-a-crash-report#Symbolicate-the-crash-report-with-the-command-line

import { exec as execCb } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execCb);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const __root = path.resolve(path.join(__dirname, ".."));
const targetDir = `${__root}/target`;

async function main() {
	const crashFile = process.argv[2];
	if (!crashFile) throw new Error("crash file not specified");

	const crashFilePath = path.join(process.cwd(), crashFile);
	const file = await fs.readFile(crashFilePath).then((b) => b.toString());

	const sections = file.split("\n\n");
	const crashedSectionIndex = sections.findIndex((s) => s.includes("Crashed:"));
	const crashedSection = sections[crashedSectionIndex];
	if (!crashedSection) throw new Error("crashed section not found");

	const crashedSectionLines = crashedSection.split("\n");

	for (let i = 1; i < crashedSectionLines.length; i++) {
		const line = crashedSectionLines[i];
		const [_left, right] = line.split("\t").map((l) => l.trim());
		const [address, loadAddressOrSymbol] = right.split(" ");
		if (!loadAddressOrSymbol.startsWith("0x")) continue;
		const loadAddress = loadAddressOrSymbol;

		const symbol = await exec(
			`atos -o "${targetDir}/Cap.dSYM" -l ${loadAddress} ${address}`,
		).then((s) => s.stdout.trim());

		const loadAddressIndex = line.indexOf(loadAddress);
		crashedSectionLines[i] =
			crashedSectionLines[i].slice(0, loadAddressIndex) + symbol;
	}

	sections[crashedSectionIndex] = crashedSectionLines.join("\n");

	await fs.writeFile(crashFilePath, Buffer.from(sections.join("\n\n"), "utf8"));
}

main();
