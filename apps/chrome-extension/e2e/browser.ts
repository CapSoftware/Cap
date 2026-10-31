import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const extensionPath = path.resolve(__dirname, "../dist");

// Chrome derives an unpacked extension's id from its absolute path: on
// Windows from the UTF-16 path with an upper-case drive letter.
export const unpackedExtensionId = createHash("sha256")
	.update(
		process.platform === "win32"
			? Buffer.from(
					extensionPath.replace(/^[a-z]:/, (drive) => drive.toUpperCase()),
					"utf16le",
				)
			: extensionPath,
	)
	.digest("hex")
	.slice(0, 32)
	.replace(/[0-9a-f]/g, (digit) =>
		String.fromCharCode(97 + Number.parseInt(digit, 16)),
	);

// CAP_E2E_BROWSER points the suites at an installed browser (Chrome, Edge,
// Brave) instead of Playwright's Chromium. Branded Chrome ignores
// --load-extension, so installed browsers load the extension over CDP.
const installedBrowser = process.env.CAP_E2E_BROWSER;

// Allows the extension's camera and mic in a new profile, as if the user had
// accepted the permission prompt. Chrome refuses CDP permission grants for
// extension origins, so the setting is written before the browser starts.
const allowExtensionMediaInProfile = async (userDataDir: string) => {
	const allow = { setting: 1 };
	const exceptions = {
		[`chrome-extension://${unpackedExtensionId}/,*`]: allow,
		[`chrome-extension://${unpackedExtensionId},*`]: allow,
	};
	await mkdir(path.join(userDataDir, "Default"), { recursive: true });
	await writeFile(
		path.join(userDataDir, "Default", "Preferences"),
		JSON.stringify({
			profile: {
				content_settings: {
					exceptions: {
						media_stream_camera: exceptions,
						media_stream_mic: exceptions,
					},
				},
			},
		}),
	);
};

export const launchExtensionBrowser = async ({
	profilePrefix,
	headless,
	args,
	allowExtensionMedia = false,
}: {
	profilePrefix: string;
	headless: boolean;
	args: string[];
	allowExtensionMedia?: boolean;
}) => {
	const userDataDir = await mkdtemp(path.join(tmpdir(), profilePrefix));
	if (allowExtensionMedia) await allowExtensionMediaInProfile(userDataDir);
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
