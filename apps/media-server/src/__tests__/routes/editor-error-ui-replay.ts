import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { chromium, type Page, webkit } from "@playwright/test";

const editorPublic = resolve(
	process.env.CAP_EDITOR_SOLID_PUBLIC_DIR ??
		resolve(import.meta.dir, "../../../../../apps/web/public/editor-solid"),
);
const screenshotRoot = resolve(
	process.env.CAP_EDITOR_ERROR_SCREENSHOT_DIR ??
		resolve(
			import.meta.dir,
			"../../../../../output/playwright/cap-editor-error",
		),
);
assert.ok(await Bun.file(join(editorPublic, "index.html")).exists());

const hostHtml = `<!doctype html>
<html>
<head><style>html,body{margin:0;height:100%;overflow:hidden}iframe{width:100vw;height:100vh;border:0}</style></head>
<body>
	<iframe id="editor" src="/editor-solid/index.html"></iframe>
	<script>
		const frame = document.getElementById("editor");
		window.addEventListener("message", (event) => {
			if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.version !== 1) return;
			if (event.data.kind === "cap-editor-error-ready") document.body.dataset.ready = "true";
			if (event.data.kind === "cap-editor-error-action") document.body.dataset.action = event.data.action;
		});
	</script>
</body>
</html>`;

async function sendError(
	page: Page,
	state: {
		message: string;
		hasBrowserDraftConflict: boolean;
		restoringBrowserDraft: boolean;
	},
) {
	await page.evaluate((data) => {
		const iframe = document.getElementById("editor") as HTMLIFrameElement;
		iframe.contentWindow?.postMessage(
			{ kind: "cap-editor-error", version: 1, ...data },
			window.location.origin,
		);
	}, state);
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/test-editor-error") {
			return new Response(hostHtml, {
				headers: { "Content-Type": "text/html; charset=utf-8" },
			});
		}
		if (url.pathname === "/favicon.ico")
			return new Response(null, { status: 204 });
		if (url.pathname.startsWith("/editor-solid/")) {
			const staticPath = resolve(
				editorPublic,
				url.pathname.slice("/editor-solid/".length),
			);
			if (
				staticPath.startsWith(`${editorPublic}${sep}`) &&
				(await Bun.file(staticPath).exists())
			) {
				const file = Bun.file(staticPath);
				return new Response(file, {
					headers: { "Content-Type": file.type },
				});
			}
			return new Response("Missing editor asset", { status: 404 });
		}
		return new Response("Not found", { status: 404 });
	},
});

try {
	await mkdir(screenshotRoot, { recursive: true });
	for (const [name, engine] of [
		["chromium", chromium],
		["webkit", webkit],
	] as const) {
		const browser = await engine.launch({ headless: true });
		try {
			const page = await browser.newPage({
				viewport: { width: 1440, height: 900 },
			});
			const pageErrors: string[] = [];
			const failedRequests: string[] = [];
			page.on("pageerror", (error) => pageErrors.push(error.message));
			page.on("requestfailed", (request) => failedRequests.push(request.url()));
			await page.goto(`${server.url}test-editor-error`);
			const frame = page.frameLocator("#editor");
			await frame.getByRole("button", { name: "Export" }).waitFor();
			const skeletonBackground = await frame
				.locator("#editor-root > div")
				.evaluate((element) => getComputedStyle(element).backgroundColor);
			await sendError(page, {
				message: "Editor preparation could not start",
				hasBrowserDraftConflict: false,
				restoringBrowserDraft: false,
			});
			await page.locator("body[data-ready=true]").waitFor();
			await frame
				.getByRole("heading", { name: "Unable to Open Recording" })
				.waitFor();
			assert.equal(
				await frame.getByRole("alert").textContent(),
				"Editor preparation could not start",
			);
			assert.equal(
				await frame.getByRole("button", { name: "Try again" }).count(),
				1,
			);
			const background = await frame
				.locator("#editor-root > div")
				.evaluate((element) => getComputedStyle(element).backgroundColor);
			assert.equal(background, skeletonBackground);
			assert.notEqual(background, "rgb(255, 255, 255)");
			await page.screenshot({
				path: join(screenshotRoot, `${name}-preparation-error.png`),
			});
			await frame.getByRole("button", { name: "Try again" }).click();
			await page.locator("body[data-action=retry]").waitFor();
			await page.evaluate(() => {
				document.body.dataset.action = "";
			});
			await sendError(page, {
				message:
					"This recording changed after the browser saved pending edits.",
				hasBrowserDraftConflict: true,
				restoringBrowserDraft: false,
			});
			await frame
				.getByRole("button", { name: "Restore browser edits" })
				.waitFor();
			assert.equal(
				await frame.getByRole("button", { name: "Try again" }).count(),
				0,
			);
			await page.screenshot({
				path: join(screenshotRoot, `${name}-browser-draft-conflict.png`),
			});
			await frame
				.getByRole("button", { name: "Restore browser edits" })
				.click();
			await page.locator("body[data-action=restore-browser]").waitFor();
			await sendError(page, {
				message:
					"This recording changed after the browser saved pending edits.",
				hasBrowserDraftConflict: true,
				restoringBrowserDraft: true,
			});
			assert.equal(
				await frame
					.getByRole("button", { name: "Restoring browser edits…" })
					.isDisabled(),
				true,
			);
			assert.equal(
				await frame
					.getByRole("button", { name: "Open latest saved" })
					.isDisabled(),
				true,
			);
			await sendError(page, {
				message:
					"This recording changed after the browser saved pending edits.",
				hasBrowserDraftConflict: true,
				restoringBrowserDraft: false,
			});
			await page.evaluate(() => {
				document.body.dataset.action = "";
			});
			await frame.getByRole("button", { name: "Open latest saved" }).click();
			await page.locator("body[data-action=open-latest]").waitFor();
			await page.evaluate(() => {
				document.body.dataset.action = "";
			});
			await frame.getByRole("button", { name: "Back to recording" }).click();
			await page.locator("body[data-action=back-to-recording]").waitFor();
			assert.deepEqual(pageErrors, []);
			assert.deepEqual(failedRequests, []);
			process.stdout.write(
				`${JSON.stringify({ browser: name, background, skeletonBackground, pageErrors, failedRequests })}\n`,
			);
		} finally {
			await browser.close();
		}
	}
} finally {
	server.stop(true);
}
