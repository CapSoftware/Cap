import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const extensionPath = path.resolve(__dirname, "../dist");

// Chrome derives an unpacked extension's id from its absolute path.
export const unpackedExtensionId = createHash("sha256")
	.update(extensionPath)
	.digest("hex")
	.slice(0, 32)
	.replace(/[0-9a-f]/g, (digit) =>
		String.fromCharCode(97 + Number.parseInt(digit, 16)),
	);

// CAP_E2E_BROWSER points the suites at an installed browser (Chrome, Edge,
// Brave) instead of Playwright's Chromium. Branded Chrome ignores
// --load-extension, so installed browsers load the extension over CDP.
const installedBrowser = process.env.CAP_E2E_BROWSER;

export const launchExtensionBrowser = async ({
	profilePrefix,
	headless,
	args,
}: {
	profilePrefix: string;
	headless: boolean;
	args: string[];
}) => {
	const userDataDir = await mkdtemp(path.join(tmpdir(), profilePrefix));
	const context = await chromium.launchPersistentContext(
		userDataDir,
		installedBrowser
			? {
					executablePath: installedBrowser,
					headless,
					ignoreDefaultArgs: ["--disable-extensions"],
					args: ["--enable-unsafe-extension-debugging", ...args],
				}
			: {
					channel: "chromium",
					headless,
					args: [
						`--disable-extensions-except=${extensionPath}`,
						`--load-extension=${extensionPath}`,
						...args,
					],
				},
	);
	if (installedBrowser) {
		const browser = context.browser();
		if (!browser) throw new Error("Installed browser did not expose CDP");
		const session = await browser.newBrowserCDPSession();
		await session.send(
			"Extensions.loadUnpacked" as never,
			{
				path: extensionPath,
			} as never,
		);
		await session.detach();
	}
	const cleanup = async () => {
		await context.close();
		await rm(userDataDir, { recursive: true, force: true });
	};
	return { context, cleanup };
};
