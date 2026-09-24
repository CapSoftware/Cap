import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	assertWorktree,
	lock,
	recordProcess,
	sessionPath,
	withSessionStartup,
} from "./core.mjs";

export function previewProfile(ctx, session) {
	return join(dirname(sessionPath(ctx, session.id)), "browser-profile");
}

export async function preview(ctx, session) {
	assertWorktree(ctx, session);
	const directory = dirname(sessionPath(ctx, session.id));
	const release = lock(join(directory, "preview.lock"));
	let browser;
	let close;
	let processPath;
	try {
		const { chromium } = await import("playwright-core");
		let closed;
		await withSessionStartup(ctx, session, async () => {
			browser = await chromium.launchPersistentContext(
				previewProfile(ctx, session),
				{
					channel: "chrome",
					headless: false,
					viewport: { width: 1440, height: 900 },
				},
			);
			closed = new Promise((resolveClose) =>
				browser.once("close", resolveClose),
			);
			close = () => {
				browser.close().catch(() => {});
			};
			process.once("SIGINT", close);
			process.once("SIGTERM", close);
			processPath = recordProcess(ctx, session, { kind: "preview" });
		});
		const storagePath = join(directory, "browser-state.json");
		if (existsSync(storagePath)) {
			const state = JSON.parse(readFileSync(storagePath, "utf8"));
			await browser.addCookies(state.cookies);
		}
		const page = browser.pages()[0] ?? (await browser.newPage());
		await page.goto(`http://127.0.0.1:${session.ports.web}`, {
			waitUntil: "domcontentloaded",
			timeout: 60000,
		});
		await closed;
	} finally {
		if (close) {
			process.removeListener("SIGINT", close);
			process.removeListener("SIGTERM", close);
		}
		await browser?.close();
		if (processPath) rmSync(processPath, { force: true });
		release();
	}
}
