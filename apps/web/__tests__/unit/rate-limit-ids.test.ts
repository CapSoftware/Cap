import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RATE_LIMIT_IDS } from "../../lib/rate-limit";

// Rate limit IDs declared in advance for firewall rules or separate app packages
// that are intentionally not yet wired in apps/web endpoints.
const UNWIRED_RATE_LIMIT_IDS = new Set([
	"AUTH_OTP_VERIFY",
	"AUTH_OTP_SEND",
	"LOOM_DOWNLOAD",
	"MESSENGER_MESSAGE",
	"DESKTOP_LOGS",
]);

function getAllTsFiles(dir: string): string[] {
	let results: string[] = [];
	const list = readdirSync(dir);
	for (const file of list) {
		const filePath = join(dir, file);
		const stat = statSync(filePath);
		if (stat && stat.isDirectory()) {
			if (file !== "node_modules" && file !== ".next" && file !== "dist") {
				results = results.concat(getAllTsFiles(filePath));
			}
		} else if (file.endsWith(".ts") || file.endsWith(".tsx")) {
			if (!filePath.endsWith("lib/rate-limit.ts") && !filePath.endsWith("rate-limit-ids.test.ts")) {
				results.push(filePath);
			}
		}
	}
	return results;
}

describe("RATE_LIMIT_IDS reference contract", () => {
	it("ensures every active declared RATE_LIMIT_ID is referenced outside lib/rate-limit.ts", () => {
		const webAppDir = join(process.cwd());
		const tsFiles = getAllTsFiles(webAppDir);

		let combinedSource = "";
		for (const file of tsFiles) {
			combinedSource += readFileSync(file, "utf8") + "\n";
		}

		const unreferencedKeys: string[] = [];

		for (const [key, value] of Object.entries(RATE_LIMIT_IDS)) {
			if (UNWIRED_RATE_LIMIT_IDS.has(key)) {
				continue;
			}

			const hasKeyRef = combinedSource.includes(`RATE_LIMIT_IDS.${key}`);
			const hasValueRef = combinedSource.includes(`"${value}"`) || combinedSource.includes(`'${value}'`);

			if (!hasKeyRef && !hasValueRef) {
				unreferencedKeys.push(key);
			}
		}

		expect(
			unreferencedKeys,
			`The following RATE_LIMIT_IDS are declared but never referenced: ${unreferencedKeys.join(", ")}`,
		).toEqual([]);
	});
});
