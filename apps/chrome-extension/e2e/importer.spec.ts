import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type BrowserContext,
	test as base,
	chromium,
	expect,
	type Page,
	type TestInfo,
	type Worker,
} from "@playwright/test";
import type { ImportContext } from "../src/importer/api";
import { parseInventory } from "../src/importer/inventory";

const extensionPath = path.resolve(
	process.env.CAP_EXTENSION_TEST_DIR ??
		path.join(path.dirname(fileURLToPath(import.meta.url)), "../dist"),
);
const authKey = "cap-extension-auth";
const settingsKey = "cap-extension-settings";
const userId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333";
const otherOrganizationId = "44444444-4444-4444-8444-444444444444";
const firstId = "0123456789abcdef0123456789abcdef";
const secondId = "fedcba9876543210fedcba9876543210";
const thirdId = "00112233445566778899aabbccddeeff";
const firstUrl = `https://www.loom.com/share/${firstId}`;
const secondUrl = `https://www.loom.com/share/${secondId}`;
const thirdUrl = `https://www.loom.com/share/${thirdId}`;
const mixedCsv = [
	"Video Link,Video Name,Creator Email,Folder,review_decision,Duration",
	`${firstUrl},Launch walkthrough,alex\\@example.test,Product / Guides,approved,02:10`,
	",Unshared walkthrough,casey@example.test,Product / Private,,01:35",
	`https://loom.com/embed/${firstId},Duplicate launch,alex@example.test,Product / Guides,approved,02:10`,
	`${secondUrl},Needs editorial review,writer@example.test,Product / Guides,pending,03:20`,
	`${thirdUrl},Release overview,pat@example.test,Engineering,approved,00:45`,
].join("\r\n");
const twoVideoCsv = [
	"Video Link,Video Name,Creator Email",
	`${firstUrl},First walkthrough,alex@example.test`,
	`${secondUrl},Second walkthrough,casey@example.test`,
].join("\r\n");
const loomWorkspace = "Synthetic Loom workspace";
const nativeLoomCsv = [
	"Video Link,Video Name,Creator Email,Workspace,Folder,Video Creation Date,Duration",
	`${firstUrl},Native launch walkthrough,alex\\@example.test,Can View,Product / Guides,2026-07-15,02:10`,
	",Unshared archive,casey@example.test,No Access,Private / Archive,2026-08-01,01:00",
	`${secondUrl},Native release overview,pat@example.test,Can View,Engineering / Releases,2026-08-12,03:10`,
].join("\r\n");
const duplicateNativeLoomCsv = [
	"Video Link,Video Name,Creator Email,Workspace,Folder,Video Creation Date,Duration",
	`${firstUrl},Native launch walkthrough,alex\\@example.test,Can View,Product / Guides,2026-07-15,02:10`,
	`${secondUrl},Native release overview,casey@example.test,Can View,Engineering / Releases,2026-08-12,03:10`,
	`https://loom.com/embed/${firstId},Duplicate native launch,alex@example.test,Can View,Product / Guides,2026-07-15,02:10`,
].join("\r\n");
const cookieName = "cap-importer-fixture-session";

type ImportRequest = {
	organizationId: string;
	row: {
		rowNumber: number;
		loomUrl: string;
		userEmail: string;
		spaceName?: string;
	};
};

type MigrationRequest = {
	requestId: string;
	expectedUserId: string;
	expectedDefaultPublic: boolean;
	organizationId: string;
	source: {
		workspace: string;
		from: string;
		to: string;
		totalRows: number;
		omittedRows: number;
	};
	rows: { rowNumber: number; loomUrl: string; userEmail: string }[];
};

const initialContext = (): ImportContext => ({
	user: { id: userId, email: "alex@example.test" },
	organizations: [
		{ id: organizationId, name: "Importer fixture team", canImport: true },
	],
	activeOrganizationId: organizationId,
	isPro: true,
	defaultPublic: false,
	maxRows: 500,
});

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
	response.writeHead(status, {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Headers": "Authorization, Content-Type",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Content-Type": "application/json",
	});
	response.end(status === 204 ? undefined : JSON.stringify(body));
};

const sendBatchReceipt = (
	response: ServerResponse,
	request: MigrationRequest,
) => {
	sendJson(response, 200, {
		operationId: "fixturebatch001",
		dashboardPath: `/dashboard/import/loom/status?operationId=fixturebatch001&organizationId=${request.organizationId}`,
	});
};

const createFixtureServer = async () => {
	const state = {
		context: initialContext(),
		requests: [] as ImportRequest[],
		contextRequests: 0,
		holdRequests: false,
		peakRequests: 0,
		invalidBearerHeaders: 0,
		cookieHeaders: 0,
		batchRequests: [] as MigrationRequest[],
		holdBatchRequests: false,
		cookieSessionRequests: 0,
		invalidCookieSessions: 0,
		unexpectedAuthorizationHeaders: 0,
	};
	let authorizedCookie: string | null = null;
	const authorizedTokens = new Set<string>();
	const pending = new Map<number, ServerResponse>();
	const pendingBatches = new Map<number, ServerResponse>();
	const active = new Set<ServerResponse>();
	const acceptCookieSession = (
		headers: { authorization?: string; cookie?: string },
		response: ServerResponse,
	) => {
		state.cookieSessionRequests++;
		const authorized =
			authorizedCookie !== null &&
			headers.cookie
				?.split(";")
				.some((value) => value.trim() === authorizedCookie);
		const hasAuthorization = headers.authorization !== undefined;
		if (!authorized) state.invalidCookieSessions++;
		if (hasAuthorization) state.unexpectedAuthorizationHeaders++;
		if (!authorized || hasAuthorization) {
			sendJson(response, 401, {
				error: "The synthetic dashboard request requires its browser session.",
			});
			return false;
		}
		return true;
	};
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (request.method === "OPTIONS") {
			sendJson(response, 204, null);
			return;
		}
		if (
			url.pathname === "/api/extension/import-loom/batch" &&
			request.method === "POST"
		) {
			if (!acceptCookieSession(request.headers, response)) return;
			const chunks: Buffer[] = [];
			for await (const chunk of request) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			const body = JSON.parse(
				Buffer.concat(chunks).toString("utf8"),
			) as MigrationRequest;
			const index = state.batchRequests.push(body) - 1;
			response.once("close", () => pendingBatches.delete(index));
			if (state.holdBatchRequests) pendingBatches.set(index, response);
			else sendBatchReceipt(response, body);
			return;
		}
		if (url.pathname === "/api/extension/import-loom") {
			if (request.method === "GET" || request.method === "POST") {
				if (authorizedCookie !== null) {
					if (!acceptCookieSession(request.headers, response)) return;
				} else {
					const authorized =
						typeof request.headers.authorization === "string" &&
						authorizedTokens.has(request.headers.authorization);
					const hasCookie = request.headers.cookie !== undefined;
					if (!authorized) state.invalidBearerHeaders++;
					if (hasCookie) state.cookieHeaders++;
					if (!authorized || hasCookie) {
						sendJson(response, 401, {
							error: "The synthetic importer request has invalid credentials.",
						});
						return;
					}
				}
			}
			if (request.method === "GET") {
				state.contextRequests++;
				sendJson(response, 200, state.context);
				return;
			}
			if (request.method === "POST") {
				const chunks: Buffer[] = [];
				for await (const chunk of request) {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				}
				const body = JSON.parse(
					Buffer.concat(chunks).toString("utf8"),
				) as ImportRequest;
				const index = state.requests.push(body) - 1;
				active.add(response);
				state.peakRequests = Math.max(state.peakRequests, active.size);
				response.once("close", () => {
					active.delete(response);
					pending.delete(index);
				});
				if (state.holdRequests) pending.set(index, response);
				else
					sendJson(response, 200, {
						success: true,
						videoId: `fixture-video-${index + 1}`,
					});
				return;
			}
		}
		if (url.pathname === "/api/extension/bootstrap") {
			sendJson(response, 200, {
				user: state.context.user,
				organization: state.context.organizations[0],
				plan: { isPro: state.context.isPro, maxRecordingSeconds: 600 },
			});
			return;
		}
		if (url.pathname.startsWith("/dashboard")) {
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			response.end(
				"<!doctype html><html><head><title>Cap fixture dashboard</title></head><body><h1>Fixture Cap dashboard</h1></body></html>",
			);
			return;
		}
		sendJson(response, 404, { error: "Unknown synthetic fixture endpoint" });
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("The importer fixture server did not get a local port.");
	}
	return {
		origin: `http://127.0.0.1:${address.port}`,
		state,
		authorize: (token: string) => authorizedTokens.add(`Bearer ${token}`),
		allowCookieSession: (value: string) => {
			authorizedCookie = `${cookieName}=${value}`;
		},
		assertHeaders: () => {
			expect(
				state.invalidBearerHeaders,
				"Importer GET and POST requests must use a seeded synthetic bearer token",
			).toBe(0);
			expect(
				state.cookieHeaders,
				"Importer GET and POST requests must omit Cookie headers",
			).toBe(0);
			expect(
				state.invalidCookieSessions,
				"Dashboard importer requests must use the seeded browser session",
			).toBe(0);
			expect(
				state.unexpectedAuthorizationHeaders,
				"Dashboard importer requests must not use extension bearer credentials",
			).toBe(0);
		},
		respond: (index: number, body: unknown) => {
			const response = pending.get(index);
			if (!response) throw new Error(`No pending fixture request ${index}.`);
			pending.delete(index);
			sendJson(response, 200, body);
		},
		releaseBatch: (index: number) => {
			const response = pendingBatches.get(index);
			const request = state.batchRequests[index];
			if (!response || !request)
				throw new Error(`No pending fixture batch ${index}.`);
			pendingBatches.delete(index);
			sendBatchReceipt(response, request);
		},
		disconnect: async (index: number, headersReceived: Promise<unknown>) => {
			const response = pending.get(index);
			if (!response) throw new Error(`No pending fixture request ${index}.`);
			pending.delete(index);
			// Chromium retries a POST if its socket closes before response headers arrive.
			response.writeHead(200, {
				"Access-Control-Allow-Origin": "*",
				"Content-Type": "application/json",
				"Content-Length": "128",
			});
			response.flushHeaders();
			response.write('{"success":true,"videoId":"');
			await headersReceived;
			response.destroy();
		},
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			}),
	};
};

type FixtureServer = Awaited<ReturnType<typeof createFixtureServer>>;

const setConnection = async (
	worker: Worker,
	server: FixtureServer,
	token: string,
	signedIn = true,
) => {
	if (signedIn) server.authorize(token);
	await worker.evaluate(
		async (values) => {
			await chrome.storage.local.set({
				[values.settingsKey]: {
					apiBaseUrl: values.apiBaseUrl,
					capture: {
						recordingMode: "fullscreen",
						camera: null,
						microphone: null,
					},
					webcam: {
						enabled: false,
						deviceId: null,
						position: "bottom-left",
						size: 230,
						shape: "round",
						mirror: false,
					},
					microphone: { enabled: false, deviceId: null },
					systemAudio: { enabled: false },
					sounds: { enabled: false },
					countdown: { enabled: false, seconds: 3 },
					microphoneWarning: { enabled: false },
				},
				[values.authKey]: values.signedIn
					? { authApiKey: values.token, userId: values.userId }
					: null,
			});
		},
		{
			settingsKey,
			authKey,
			apiBaseUrl: server.origin,
			token,
			signedIn,
			userId: server.state.context.user.id,
		},
	);
};

type Harness = {
	context: BrowserContext;
	page: Page;
	worker: Worker;
	server: FixtureServer;
	token: string;
	url: string;
	open: (signedIn?: boolean) => Promise<void>;
};

const test = base.extend<{ harness: Harness }>({
	harness: async ({ browserName }, use) => {
		if (browserName !== "chromium")
			throw new Error("The importer extension tests require Chromium.");
		const profile = await mkdtemp(path.join(tmpdir(), "cap-importer-e2e-"));
		const server = await createFixtureServer();
		let context: BrowserContext | undefined;
		try {
			context = await chromium.launchPersistentContext(profile, {
				channel: "chromium",
				headless: true,
				acceptDownloads: true,
				viewport: { width: 1440, height: 1100 },
				args: [
					"--no-proxy-server",
					// Extension-created tabs can navigate before Playwright installs their route.
					"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
					`--disable-extensions-except=${extensionPath}`,
					`--load-extension=${extensionPath}`,
				],
			});
			await context.route(/^https?:\/\//, async (route) => {
				if (new URL(route.request().url()).hostname === "127.0.0.1")
					await route.continue();
				else await route.abort("blockedbyclient");
			});
			const worker =
				context
					.serviceWorkers()
					.find((item) => item.url().includes("assets/service-worker.js")) ??
				(await context.waitForEvent("serviceworker", (item) =>
					item.url().includes("assets/service-worker.js"),
				));
			await worker.evaluate(async () => chrome.storage.local.clear());
			const page = await context.newPage();
			const url = `chrome-extension://${new URL(worker.url()).host}/import.html`;
			const token = randomUUID();
			await use({
				context,
				page,
				worker,
				server,
				token,
				url,
				open: async (signedIn = true) => {
					await setConnection(worker, server, token, signedIn);
					await page.goto(url);
					await expect(
						page.getByRole("heading", { name: "Drop your export here" }),
					).toBeVisible();
					if (signedIn)
						await expect
							.poll(() => server.state.contextRequests)
							.toBeGreaterThan(0);
				},
			});
			server.assertHeaders();
		} finally {
			try {
				await context?.close();
			} finally {
				await server.close();
				await rm(profile, { recursive: true, force: true });
			}
		}
	},
});

const uploadInventory = async (
	page: Page,
	content = mixedCsv,
	name = "synthetic-loom.csv",
) => {
	await page.getByLabel("Choose inventory file").setInputFiles({
		name,
		mimeType: name.endsWith(".json")
			? "application/json"
			: name.endsWith(".tsv")
				? "text/tab-separated-values"
				: "text/csv",
		buffer: Buffer.from(content),
	});
	await expect(page.getByText(name, { exact: true })).toBeVisible();
	await expect(
		page.getByRole("region", { name: "Video inventory" }),
	).toBeVisible();
};

const recordRow = (page: Page, record: number) =>
	page.getByRole("row").filter({
		has: page.getByRole("checkbox", {
			name: `Select record ${record}`,
			exact: true,
		}),
	});

const downloadCsv = async (
	page: Page,
	testInfo: TestInfo,
	label: string,
	filename: string,
) => {
	const pending = page.waitForEvent("download");
	await page.getByRole("button", { name: label, exact: true }).click();
	const download = await pending;
	expect(download.suggestedFilename()).toBe(filename);
	const destination = testInfo.outputPath(filename);
	await download.saveAs(destination);
	expect(await download.failure()).toBeNull();
	return readFile(destination, "utf8");
};

const confirmImport = async (page: Page, count: number) => {
	await page
		.getByRole("button", {
			name: `Import ${count} ${count === 1 ? "video" : "videos"}`,
			exact: true,
		})
		.click();
	const dialog = page.getByRole("dialog", {
		name: "Ready to bring these over?",
	});
	const start = dialog.getByRole("button", {
		name: `Start ${count} ${count === 1 ? "import" : "imports"}`,
		exact: true,
	});
	await expect(start).toBeDisabled();
	await dialog
		.getByRole("checkbox", {
			name: "I’ve reviewed the selected videos, owners, Spaces and visibility.",
		})
		.check();
	await start.click();
};

const readSaved = (page: Page, key: "draft" | "run") =>
	page.evaluate(
		(key) =>
			new Promise<unknown>((resolve, reject) => {
				const opened = indexedDB.open("cap-loom-importer", 1);
				opened.onerror = () => reject(opened.error);
				opened.onsuccess = () => {
					const database = opened.result;
					const transaction = database.transaction("inventory", "readonly");
					const request = transaction.objectStore("inventory").get(key);
					transaction.oncomplete = () => {
						database.close();
						resolve(request.result ?? null);
					};
					transaction.onabort = () => {
						database.close();
						reject(transaction.error);
					};
				};
			}),
		key,
	);

const routeNativeLoom = async (
	context: BrowserContext,
	options: {
		csv?: string;
		totalRows?: number;
		workspaceAfterDownload?: string;
		from?: string;
		to?: string;
	} = {},
) => {
	const state = {
		requests: 0,
		authorizationHeaders: 0,
		cookieHeaders: 0,
	};
	const csv = JSON.stringify(options.csv ?? nativeLoomCsv).replaceAll(
		"<",
		"\\u003c",
	);
	const body = `<!doctype html>
<html><head><meta charset="utf-8"><title>Synthetic Loom workspace export</title></head>
<body><header><button id="workspace-selector" type="button">${loomWorkspace}</button>
<a id="loom-space-nav" href="/spaces/fixture-product-guides">Product guides</a></header>
<main><nav aria-label="Breadcrumb"><span id="workspace-breadcrumb">${loomWorkspace}</span><span> / </span></nav>
<h1>Workspace Settings Data</h1>
<section aria-label="Engagement report">
<h2>Export engagement insights</h2>
<label for="from">Start date</label><input id="from" type="date" value="${options.from ?? "2026-08-01"}">
<label for="to">End date</label><input id="to" type="date" value="${options.to ?? "2026-08-31"}">
<p>Export all ${options.totalRows ?? 3} videos created in this date range.</p>
<table><thead><tr><th>Workspace</th><th>Video Name</th></tr></thead>
<tbody><tr><td>Can View</td><td>Native launch walkthrough</td></tr></tbody></table>
<button id="download-csv" type="button">Download CSV</button>
</section></main>
<script>
window.__nativeLoomFixture = {
 exports: 0,
 createObjectURL: URL.createObjectURL,
 anchorClick: HTMLAnchorElement.prototype.click
};
document.getElementById("download-csv").addEventListener("click", () => {
 window.__nativeLoomFixture.exports += 1;
 const workspaceAfterDownload = ${JSON.stringify(options.workspaceAfterDownload ?? null)};
 if (workspaceAfterDownload) {
  document.getElementById("workspace-selector").textContent = workspaceAfterDownload;
  document.getElementById("workspace-breadcrumb").textContent = workspaceAfterDownload;
 }
 const url = URL.createObjectURL(new Blob([${csv}], {type: "text/csv;charset=utf-8"}));
 const anchor = document.createElement("a");
 anchor.href = url;
 anchor.download = "synthetic-native-loom.csv";
 document.body.append(anchor);
 anchor.click();
 anchor.remove();
});
</script></body></html>`;
	await context.route("https://www.loom.com/**", async (route) => {
		state.requests++;
		const headers = await route.request().allHeaders();
		if (headers.authorization) state.authorizationHeaders++;
		if (headers.cookie) state.cookieHeaders++;
		await route.fulfill({
			status: 200,
			contentType: "text/html; charset=utf-8",
			body,
		});
	});
	const page = await context.newPage();
	await page.goto("https://www.loom.com/settings/workspace#data");
	await expect(
		page.getByRole("heading", {
			name: "Export engagement insights",
			exact: true,
		}),
	).toBeVisible();
	return state;
};

const readNativeCaptureState = (page: Page) =>
	page.evaluate(() => {
		const fixture = (
			window as Window & {
				__nativeLoomFixture?: {
					exports: number;
					createObjectURL: typeof URL.createObjectURL;
					anchorClick: typeof HTMLAnchorElement.prototype.click;
				};
			}
		).__nativeLoomFixture;
		if (!fixture) throw new Error("The synthetic Loom fixture did not load.");
		return {
			exports: fixture.exports,
			createObjectURLRestored: URL.createObjectURL === fixture.createObjectURL,
			anchorClickRestored:
				HTMLAnchorElement.prototype.click === fixture.anchorClick,
		};
	});

const openMigration = async (harness: Harness) => {
	await setConnection(harness.worker, harness.server, harness.token, false);
	await harness.page.goto(new URL("migrate.html", harness.url).toString());
	await expect(
		harness.page.getByRole("heading", {
			name: "Move your Loom library to Cap",
			exact: true,
		}),
	).toBeVisible();
};

const connectNativeLoom = async (harness: Harness) => {
	const loom = harness.context
		.pages()
		.find(
			(page) => page.url() === "https://www.loom.com/settings/workspace#data",
		);
	if (!loom) throw new Error("The routed synthetic Loom tab was not opened.");
	await loom.reload();
	await harness.page
		.getByRole("button", { name: "Connect Loom", exact: true })
		.click();
	await expect(loom).toHaveURL("https://www.loom.com/settings/workspace#data");
	await expect(
		harness.page.getByText(loomWorkspace, { exact: true }),
	).toBeVisible();
	await expect(
		harness.page.getByRole("button", { name: "Next", exact: true }),
	).toBeEnabled();
	return loom;
};

const prepareNativeLoom = async (harness: Harness) => {
	const loom = await connectNativeLoom(harness);
	await harness.page.getByRole("button", { name: "Next", exact: true }).click();
	await expect(
		harness.page.getByRole("heading", {
			name: "Your CSV is ready",
			exact: true,
		}),
	).toBeVisible();
	return loom;
};

const expandMigrationPreview = async (page: Page) => {
	await page
		.getByText("Preview videos and full report", { exact: true })
		.click();
	await expect(
		page.getByRole("region", { name: "Video inventory" }),
	).toBeVisible();
};

const seedCapCookieSession = async (harness: Harness) => {
	const cookie = randomUUID();
	harness.server.allowCookieSession(cookie);
	await harness.context.addCookies([
		{
			name: cookieName,
			value: cookie,
			url: harness.server.origin,
			httpOnly: true,
			sameSite: "Lax",
		},
	]);
};

const connectCookieCap = async (harness: Harness) => {
	await seedCapCookieSession(harness);
	const existing = harness.context
		.pages()
		.find((page) =>
			page.url().startsWith(`${harness.server.origin}/dashboard`),
		);
	const opened = existing
		? Promise.resolve(existing)
		: harness.context.waitForEvent("page");
	await harness.page
		.getByRole("button", { name: "Import to Cap", exact: true })
		.click();
	const cap = await opened;
	await expect(cap).toHaveURL(`${harness.server.origin}/dashboard/caps`);
	await expect(
		harness.page.getByRole("heading", { name: "Import to Cap", exact: true }),
	).toBeVisible();
	await expect(
		harness.page
			.getByRole("region", {
				name: "Confirm your Cap destination",
				exact: true,
			})
			.getByText("alex@example.test", { exact: true }),
	).toBeVisible();
	await expect(
		harness.page.getByRole("combobox", {
			name: "Cap organization",
			exact: true,
		}),
	).toHaveValue(organizationId);
	return cap;
};

test("signed-out review retains attention records and downloads only the selected import rows", async ({
	harness,
}, testInfo) => {
	const { page, server } = harness;
	await harness.open(false);
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.screenshot({
		path: testInfo.outputPath("importer-empty.png"),
		fullPage: true,
		animations: "disabled",
	});
	await uploadInventory(page);
	await expect(
		page.getByText("5 source records · saved locally"),
	).toBeVisible();
	await expect(
		page.getByRole("checkbox", { name: "Select record 1", exact: true }),
	).toBeChecked();
	await expect(
		page.getByRole("checkbox", { name: "Select record 5", exact: true }),
	).toBeChecked();
	for (const record of [2, 3, 4]) {
		await expect(
			page.getByRole("checkbox", {
				name: `Select record ${record}`,
				exact: true,
			}),
		).not.toBeChecked();
	}
	await expect(
		page.getByRole("checkbox", { name: "Select record 2", exact: true }),
	).toBeDisabled();
	await expect(
		page.getByRole("checkbox", { name: "Select record 3", exact: true }),
	).toBeDisabled();
	await expect(recordRow(page, 2)).toContainText("Missing link");
	await expect(recordRow(page, 3)).toContainText("Duplicate");
	await expect(recordRow(page, 4)).toContainText("Needs review");
	await page.getByRole("button", { name: "Select ready", exact: true }).click();
	await expect(
		page.getByRole("checkbox", { name: "Select record 4", exact: true }),
	).not.toBeChecked();
	await expect(
		page.getByRole("button", { name: "Sign in to Cap", exact: true }),
	).toBeVisible();
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.screenshot({
		path: testInfo.outputPath("importer-inventory.png"),
		fullPage: true,
		animations: "disabled",
	});

	const selected = parseInventory(
		await downloadCsv(
			page,
			testInfo,
			"Download import CSV",
			"cap-loom-import.csv",
		),
		"selected.csv",
	);
	expect(selected.headers).toEqual([
		"loom_video_url",
		"user_email",
		"space_name",
	]);
	expect(selected.records).toEqual([
		[firstUrl, "alex@example.test", ""],
		[thirdUrl, "pat@example.test", ""],
	]);
	const report = parseInventory(
		await downloadCsv(
			page,
			testInfo,
			"Download full report",
			"cap-loom-inventory-report.csv",
		),
		"report.csv",
	);
	expect(report.records).toHaveLength(5);
	expect(
		report.records.map(
			(record) => record[report.headers.indexOf("source_record_number")],
		),
	).toEqual(["1", "2", "3", "4", "5"]);
	expect(
		report.records.map(
			(record) => record[report.headers.indexOf("validation_status")],
		),
	).toEqual(["ready", "missing-link", "duplicate", "review-required", "ready"]);
	expect(report.records[1].slice(0, 4)).toEqual([
		"",
		"Unshared walkthrough",
		"casey@example.test",
		"Product / Private",
	]);
	expect(server.state.requests).toEqual([]);
	expect(server.state.contextRequests).toBe(0);
	await page.setViewportSize({ width: 480, height: 960 });
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.screenshot({
		path: testInfo.outputPath("importer-inventory-narrow.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("the signed-out popup opens account migration and keeps the manual CSV tool available", async ({
	harness,
}) => {
	const { page, context, server, worker, token } = harness;
	await setConnection(worker, server, token, false);
	await page.goto(new URL("popup.html", harness.url).toString());
	const opened = context.waitForEvent("page");
	await page
		.getByRole("button", { name: "Import from Loom", exact: true })
		.click();
	const importer = await opened;
	await expect(importer).toHaveURL(
		new URL("migrate.html", harness.url).toString(),
	);
	await expect(
		importer.getByRole("heading", {
			name: "Move your Loom library to Cap",
			exact: true,
		}),
	).toBeVisible();
	await expect(
		importer.getByRole("button", { name: "Connect Loom", exact: true }),
	).toBeVisible();
	await importer
		.getByRole("link", { name: "Open the CSV file tool", exact: true })
		.click();
	await expect(importer).toHaveURL(harness.url);
	await uploadInventory(importer, twoVideoCsv);
	await expect(
		importer.getByRole("button", { name: "Sign in to Cap", exact: true }),
	).toBeVisible();
	expect(server.state.requests).toEqual([]);
	expect(server.state.contextRequests).toBe(0);
});

test("empty and malformed files show errors, then a valid JSON inventory can be reviewed", async ({
	harness,
}) => {
	const { page, server } = harness;
	await harness.open(false);
	await page.getByLabel("Choose inventory file").setInputFiles({
		name: "empty.csv",
		mimeType: "text/csv",
		buffer: Buffer.alloc(0),
	});
	await expect(page.getByRole("alert")).toContainText("This file is empty.");
	await expect(
		page.getByRole("heading", { name: "Drop your export here", exact: true }),
	).toBeVisible();
	await page.getByLabel("Choose inventory file").setInputFiles({
		name: "malformed.json",
		mimeType: "application/json",
		buffer: Buffer.from('{"videos":['),
	});
	await expect(page.getByRole("alert")).toContainText("not valid JSON");
	await uploadInventory(
		page,
		JSON.stringify({
			videos: [
				{
					loom_video_url: firstUrl,
					title: "JSON walkthrough",
					user_email: "alex@example.test",
					review_decision: "",
				},
			],
		}),
		"synthetic-loom.json",
	);
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(recordRow(page, 1)).toContainText("JSON walkthrough");
	await expect(recordRow(page, 1)).toContainText("Needs review");
	await page.getByRole("button", { name: "Select ready", exact: true }).click();
	await expect(
		page.getByRole("checkbox", { name: "Select record 1", exact: true }),
	).not.toBeChecked();
	await expect(
		page.getByRole("button", { name: "Download import CSV", exact: true }),
	).toBeDisabled();
	await page
		.getByRole("checkbox", { name: "Select record 1", exact: true })
		.check();
	await expect(
		page.getByRole("checkbox", { name: "Select record 1", exact: true }),
	).toBeChecked();
	expect(server.state.requests).toEqual([]);
});

test("owner overrides keep provenance and folder paths map only to an explicitly chosen flat Space", async ({
	harness,
}, testInfo) => {
	const { page } = harness;
	await harness.open(false);
	await uploadInventory(
		page,
		`Video Link\tVideo Name\tCreator\tFolder\n${firstUrl}\tTraining walkthrough\talex\\@example.test\tTeams / Enablement\n${secondUrl}\tSupport walkthrough\tcasey@example.test\tTeams / Support`,
		"synthetic-loom.tsv",
	);
	await expect(
		page.getByRole("combobox", { name: "Destination Space", exact: true }),
	).toHaveValue("none");
	await expect(recordRow(page, 1)).toContainText("No Space");
	await page
		.getByRole("combobox", { name: "Cap video owner", exact: true })
		.selectOption("override");
	await page
		.getByLabel("Owner email", { exact: true })
		.fill("import-owner@example.test");
	await expect(recordRow(page, 1)).toContainText("From alex@example.test");
	await page
		.getByRole("combobox", { name: "Destination Space", exact: true })
		.selectOption("column");
	await expect(
		page.getByRole("combobox", { name: "Space column", exact: true }),
	).toHaveValue("-1");
	await page
		.getByRole("combobox", { name: "Space column", exact: true })
		.selectOption({ label: "Folder" });
	await expect(recordRow(page, 1).locator("td").nth(3)).toHaveText(
		"Teams / Enablement",
	);
	await expect(
		page.getByText("Named Spaces are reused or created as flat Spaces.", {
			exact: false,
		}),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Source details for record 1", exact: true })
		.click();
	await expect(
		page.getByText("alex\\@example.test", { exact: true }),
	).toBeVisible();

	const csv = parseInventory(
		await downloadCsv(
			page,
			testInfo,
			"Download import CSV",
			"cap-loom-import.csv",
		),
		"selected.csv",
	);
	expect(csv.records).toEqual([
		[firstUrl, "import-owner@example.test", "Teams / Enablement"],
		[secondUrl, "import-owner@example.test", "Teams / Support"],
	]);
});

test("Pro and organization-role gates disable submission without blocking local review", async ({
	harness,
}) => {
	const { page, server } = harness;
	server.state.context.isPro = false;
	server.state.context.organizations = [
		{ id: organizationId, name: "Read-only fixture team", canImport: false },
		{ id: otherOrganizationId, name: "Managed fixture team", canImport: true },
	];
	await harness.open();
	await uploadInventory(page, twoVideoCsv);
	await expect(
		page.getByRole("button", { name: "Import 2 videos", exact: true }),
	).toBeDisabled();
	await expect(
		page.getByText("Loom imports require Cap Pro.", { exact: false }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Download import CSV", exact: true }),
	).toBeEnabled();

	server.state.context.isPro = true;
	await page.reload();
	await expect(
		page.getByText(
			"Choose an organization where you’re an admin or owner to import.",
		),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Import 2 videos", exact: true }),
	).toBeDisabled();
	await page
		.getByRole("combobox", { name: "Cap organization", exact: true })
		.selectOption(otherOrganizationId);
	await expect(
		page.getByRole("button", { name: "Import 2 videos", exact: true }),
	).toBeEnabled();
	expect(server.state.requests).toEqual([]);
});

test("confirmation starts only selected valid videos, one request at a time, without claiming completion", async ({
	harness,
}, testInfo) => {
	const { page, server } = harness;
	server.state.holdRequests = true;
	await harness.open();
	await uploadInventory(page);
	await page
		.getByRole("checkbox", { name: "Select record 5", exact: true })
		.uncheck();
	await page
		.getByRole("checkbox", { name: "Select record 4", exact: true })
		.check();
	await page
		.getByRole("button", { name: "Import 2 videos", exact: true })
		.click();
	const dialog = page.getByRole("dialog", {
		name: "Ready to bring these over?",
	});
	await expect(dialog).toContainText("Importer fixture team");
	await expect(
		dialog.getByText("alex@example.test", { exact: true }),
	).toBeVisible();
	await expect(dialog).toContainText("Private");
	await expect(
		dialog.getByRole("button", { name: "Start 2 imports", exact: true }),
	).toBeDisabled();
	expect(server.state.requests).toEqual([]);
	await dialog
		.getByRole("checkbox", {
			name: "I’ve reviewed the selected videos, owners, Spaces and visibility.",
		})
		.check();
	await dialog
		.getByRole("button", { name: "Start 2 imports", exact: true })
		.click();
	await expect.poll(() => server.state.requests.length).toBe(1);
	await expect(recordRow(page, 1)).toContainText("Starting…");
	server.respond(0, { success: true, videoId: "fixture-started-one" });
	await expect.poll(() => server.state.requests.length).toBe(2);
	server.respond(1, {
		success: true,
		videoId: "fixture-existing-review",
		existing: true,
	});
	await expect(
		page.getByRole("heading", { name: "Your import progress", exact: true }),
	).toBeVisible();
	await expect(recordRow(page, 1)).toContainText("Started in Cap");
	await expect(recordRow(page, 4)).toContainText("Already in Cap");
	await expect(
		page.getByText(
			"“Started” means Cap accepted the import, not that processing or playback is complete.",
			{ exact: false },
		),
	).toBeVisible();
	await expect(
		page.getByRole("combobox", { name: "Cap video owner", exact: true }),
	).toBeDisabled();
	expect(server.state.peakRequests).toBe(1);
	expect(server.state.requests).toEqual([
		{
			organizationId,
			row: { rowNumber: 1, loomUrl: firstUrl, userEmail: "alex@example.test" },
		},
		{
			organizationId,
			row: {
				rowNumber: 4,
				loomUrl: secondUrl,
				userEmail: "writer@example.test",
			},
		},
	]);
	await expect(
		page.getByRole("button", { name: "Download import CSV", exact: true }),
	).toBeDisabled();
	await page
		.getByRole("checkbox", { name: "Select record 5", exact: true })
		.check();
	const remaining = parseInventory(
		await downloadCsv(
			page,
			testInfo,
			"Download import CSV",
			"cap-loom-import.csv",
		),
		"remaining.csv",
	);
	expect(remaining.records).toEqual([[thirdUrl, "pat@example.test", ""]]);
	const report = parseInventory(
		await downloadCsv(
			page,
			testInfo,
			"Download full report",
			"cap-loom-inventory-report.csv",
		),
		"report.csv",
	);
	expect(
		report.records.map(
			(record) => record[report.headers.indexOf("cap_import_status")],
		),
	).toEqual([
		"started",
		"not-submitted",
		"not-submitted",
		"existing",
		"not-submitted",
	]);
});

test("an uncertain network result stops the queue and locks that record against replay", async ({
	harness,
}, testInfo) => {
	const { page, server } = harness;
	server.state.holdRequests = true;
	await harness.open();
	await uploadInventory(page, twoVideoCsv);
	await confirmImport(page, 2);
	await expect.poll(() => server.state.requests.length).toBe(1);
	const headersReceived = page.waitForResponse(
		(response) =>
			response.url() === `${server.origin}/api/extension/import-loom` &&
			response.request().method() === "POST",
	);
	await server.disconnect(0, headersReceived);
	await expect
		.poll(async () => ({
			requestCount: server.state.requests.length,
			saved: await readSaved(page, "run"),
		}))
		.toMatchObject({
			requestCount: 1,
			saved: { outcomes: { 1: { state: "uncertain" } } },
		});
	await expect(
		page.getByRole("heading", { name: "Your import progress", exact: true }),
	).toBeVisible();
	await expect(recordRow(page, 1)).toContainText("Check in Cap");
	await expect(
		page.getByRole("checkbox", { name: "Select record 1", exact: true }),
	).toBeDisabled();
	await expect(
		page.getByText(
			"Unconfirmed rows are locked to prevent accidental repeats.",
			{ exact: false },
		),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Import 1 video", exact: true }),
	).toBeEnabled();
	expect(server.state.requests.map((request) => request.row.rowNumber)).toEqual(
		[1],
	);
	const remaining = parseInventory(
		await downloadCsv(
			page,
			testInfo,
			"Download import CSV",
			"cap-loom-import.csv",
		),
		"remaining.csv",
	);
	expect(remaining.records).toEqual([[secondUrl, "casey@example.test", ""]]);
});

test("a deselection is retained when the saved inventory is immediately reloaded", async ({
	harness,
}) => {
	const { page } = harness;
	await harness.open(false);
	await uploadInventory(page, twoVideoCsv);
	await page
		.getByRole("checkbox", { name: "Select record 2", exact: true })
		.uncheck();
	await expect
		.poll(() => readSaved(page, "draft"))
		.toMatchObject({ selected: [1] });
	page.once("dialog", async (dialog) => dialog.accept());
	await page.reload();
	await expect(
		page.getByRole("checkbox", { name: "Select record 1", exact: true }),
	).toBeChecked();
	await expect(
		page.getByRole("checkbox", { name: "Select record 2", exact: true }),
	).not.toBeChecked();
});

test("corrupt saved progress is reported without discarding it or submitting videos", async ({
	harness,
}) => {
	const { page, server } = harness;
	await harness.open(false);
	await uploadInventory(page, twoVideoCsv);
	const corruptedRun = {
		draftId: "corrupted-fixture",
		outcomes: { 1: { sourceRecord: 1, state: "future-unknown-state" } },
	};
	await page.evaluate(
		(run) =>
			new Promise<void>((resolve, reject) => {
				const opened = indexedDB.open("cap-loom-importer", 1);
				opened.onerror = () => reject(opened.error);
				opened.onsuccess = () => {
					const database = opened.result;
					const transaction = database.transaction("inventory", "readwrite");
					transaction.objectStore("inventory").put(run, "run");
					transaction.oncomplete = () => {
						database.close();
						resolve();
					};
					transaction.onabort = () => {
						database.close();
						reject(transaction.error);
					};
				};
			}),
		corruptedRun,
	);
	await page.reload();
	await expect(page.getByRole("alert")).toContainText(
		"Saved import progress cannot be read safely.",
	);
	expect(await readSaved(page, "run")).toEqual(corruptedRun);
	await expect(page.getByRole("button", { name: /^Import \d/ })).toHaveCount(0);
	expect(server.state.requests).toEqual([]);
});

test("reload restores the inventory and turns an interrupted sending record into a locked uncertainty", async ({
	harness,
}) => {
	const { page, server } = harness;
	server.state.holdRequests = true;
	await harness.open();
	await uploadInventory(page, twoVideoCsv);
	await confirmImport(page, 2);
	await expect.poll(() => server.state.requests.length).toBe(1);
	await expect
		.poll(() => readSaved(page, "run"))
		.toMatchObject({ outcomes: { 1: { state: "sending" } } });
	page.once("dialog", async (dialog) => dialog.accept());
	await page.reload();
	await expect(
		page.getByText("2 source records · saved locally"),
	).toBeVisible();
	await expect(recordRow(page, 1)).toContainText("Check in Cap");
	await expect(
		page.getByRole("checkbox", { name: "Select record 1", exact: true }),
	).toBeDisabled();
	await expect(
		page.getByRole("checkbox", { name: "Select record 2", exact: true }),
	).toBeChecked();
	await expect(
		page.getByRole("button", { name: "Import 1 video", exact: true }),
	).toBeEnabled();
	await expect
		.poll(() => readSaved(page, "run"))
		.toMatchObject({ outcomes: { 1: { state: "uncertain" } } });
	expect(server.state.requests.map((request) => request.row.rowNumber)).toEqual(
		[1],
	);
});

test("one tab owns the inventory and a saved run cannot move to another Cap server or account", async ({
	harness,
}) => {
	const { page, server, worker, token } = harness;
	const alternateServer = await createFixtureServer();
	try {
		await harness.open();
		await uploadInventory(page, twoVideoCsv);
		const otherTab = await harness.context.newPage();
		await otherTab.goto(harness.url);
		await expect(
			otherTab.getByRole("heading", {
				name: "Your importer is already open",
				exact: true,
			}),
		).toBeVisible();
		await expect(otherTab.getByLabel("Choose inventory file")).toHaveCount(0);
		await page
			.getByRole("checkbox", { name: "Select record 2", exact: true })
			.uncheck();
		await confirmImport(page, 1);
		await expect(recordRow(page, 1)).toContainText("Started in Cap");
		await expect(
			page.getByRole("heading", { name: "Your import progress", exact: true }),
		).toBeVisible();
		await page
			.getByRole("checkbox", { name: "Select record 2", exact: true })
			.check();
		await expect(
			page.getByRole("button", { name: "Import 1 video", exact: true }),
		).toBeEnabled();

		const alternateContext = page.waitForResponse(
			(response) =>
				response.url() ===
					`${alternateServer.origin}/api/extension/import-loom` &&
				response.request().method() === "GET",
		);
		await setConnection(worker, alternateServer, token);
		await alternateContext;
		await expect(
			page.getByRole("combobox", { name: "Cap organization", exact: true }),
		).toBeVisible();
		await expect(
			page.getByText("Connecting to Cap…", { exact: true }),
		).toHaveCount(0);
		await expect(
			page.getByText("This run belongs to a different Cap connection.", {
				exact: false,
			}),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Import 1 video", exact: true }),
		).toBeDisabled();
		await expect(
			recordRow(page, 1).getByRole("link", {
				name: "Open in Cap",
				exact: true,
			}),
		).toHaveAttribute("href", `${server.origin}/s/fixture-video-1`);

		server.state.context.user = {
			id: otherUserId,
			email: "other@example.test",
		};
		const otherAccountContext = page.waitForResponse(
			(response) =>
				response.url() === `${server.origin}/api/extension/import-loom` &&
				response.request().method() === "GET",
		);
		await setConnection(worker, server, randomUUID());
		await otherAccountContext;
		await expect(
			page.getByRole("combobox", { name: "Cap organization", exact: true }),
		).toBeVisible();
		await expect(
			page.getByText("Connecting to Cap…", { exact: true }),
		).toHaveCount(0);
		await expect(
			page.getByText("This run belongs to a different Cap connection.", {
				exact: false,
			}),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Import 1 video", exact: true }),
		).toBeDisabled();
		server.state.context.user = initialContext().user;
		await setConnection(worker, server, token);
		await expect(
			page.getByRole("button", { name: "Import 1 video", exact: true }),
		).toBeEnabled();
		await expect
			.poll(() => readSaved(page, "draft"))
			.toMatchObject({ selected: [1, 2] });
		expect(server.state.requests).toHaveLength(1);
		expect(alternateServer.state.requests).toEqual([]);

		await page.close();
		await otherTab.reload();
		await expect(
			otherTab.getByText("2 source records · saved locally"),
		).toBeVisible();
		await expect(recordRow(otherTab, 1)).toContainText("Started in Cap");
		alternateServer.assertHeaders();
	} finally {
		await alternateServer.close();
	}
});

test("native Loom CSV-only capture preserves omitted records without contacting Cap and restores the download hooks", async ({
	harness,
}, testInfo) => {
	const { page, context, server } = harness;
	const loomRequests = await routeNativeLoom(context);
	await page.emulateMedia({ reducedMotion: "reduce" });
	await openMigration(harness);
	const from = page.getByLabel("From", { exact: true });
	const through = page.getByLabel("Through", { exact: true });
	await expect(from).toBeHidden();
	await expect(through).toBeHidden();
	for (const name of ["Next", "Connect Cap", "Import to Cap", "Start import"]) {
		await expect(page.getByRole("button", { name, exact: true })).toBeHidden();
	}
	const exportOptions = page.getByText("Export options", { exact: true });
	await exportOptions.click();
	await expect(from).toBeVisible();
	await expect(through).toBeVisible();
	await expect(from).toHaveValue("1970-01-01");
	const today = await page.evaluate(() => {
		const now = new Date();
		return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	});
	await expect(through).toHaveValue(today);
	await exportOptions.click();
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.screenshot({
		path: testInfo.outputPath("migration-empty.png"),
		fullPage: true,
		animations: "disabled",
	});
	const reference = await context.newPage();
	await reference.goto(new URL("how-it-works.html", harness.url).toString());
	await expect(
		reference.getByRole("heading", { name: "How Cap works", exact: true }),
	).toBeVisible();
	await reference.screenshot({
		path: testInfo.outputPath("theme-how-it-works.png"),
		fullPage: true,
		animations: "disabled",
	});
	await reference.close();

	const loom = await connectNativeLoom(harness);
	await expect(loom.getByLabel("Start date", { exact: true })).toHaveValue(
		"1970-01-01",
	);
	await expect(loom.getByLabel("End date", { exact: true })).toHaveValue(today);
	expect(server.state.contextRequests).toBe(0);
	expect(server.state.batchRequests).toEqual([]);
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.screenshot({
		path: testInfo.outputPath("migration-loom-connected.png"),
		fullPage: true,
		animations: "disabled",
	});
	const nativeDownload = loom.waitForEvent("download");
	await page.getByRole("button", { name: "Next", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Your CSV is ready", exact: true }),
	).toBeVisible();
	const sourceDownload = await nativeDownload;
	expect(sourceDownload.suggestedFilename()).toBe("synthetic-native-loom.csv");
	expect(await sourceDownload.failure()).toBeNull();
	expect(await readNativeCaptureState(loom)).toEqual({
		exports: 1,
		createObjectURLRestored: true,
		anchorClickRestored: true,
	});
	const preview = page.getByRole("region", { name: "Video inventory" });
	await expect(preview).toBeHidden();
	await expect(
		page.getByRole("button", { name: "Download full report", exact: true }),
	).toBeHidden();
	await expect(
		page.getByRole("button", { name: "Import to Cap", exact: true }),
	).toBeEnabled();
	for (const name of ["Connect Cap", "Start import"]) {
		await expect(page.getByRole("button", { name, exact: true })).toBeHidden();
	}
	await expect(
		page.getByRole("checkbox", { name: /^I understand/ }),
	).toBeHidden();
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.screenshot({
		path: testInfo.outputPath("migration-csv-ready.png"),
		fullPage: true,
		animations: "disabled",
	});
	await expandMigrationPreview(page);
	for (const [record, status] of [
		[1, "Ready"],
		[2, "Missing link"],
		[3, "Ready"],
	] as const) {
		const row = preview.getByRole("row").filter({
			has: page.getByRole("button", {
				name: `Source details for record ${record}`,
				exact: true,
			}),
		});
		await expect(row).toContainText(status);
		await expect(row).toContainText("No Space");
	}
	await expect(preview.getByRole("checkbox")).toHaveCount(0);
	const csv = await downloadCsv(
		page,
		testInfo,
		"Download CSV",
		"cap-loom-import.csv",
	);
	expect(parseInventory(csv, "prepared.csv")).toEqual({
		headers: ["loom_video_url", "user_email", "space_name"],
		records: [
			[firstUrl, "alex@example.test", ""],
			[secondUrl, "pat@example.test", ""],
		],
	});
	const report = parseInventory(
		await downloadCsv(
			page,
			testInfo,
			"Download full report",
			"cap-loom-inventory-report.csv",
		),
		"report.csv",
	);
	const source = parseInventory(nativeLoomCsv, "native.csv");
	expect(report.headers.slice(0, source.headers.length)).toEqual(
		source.headers,
	);
	expect(
		report.records.map((row) => row.slice(0, source.headers.length)),
	).toEqual(source.records);
	expect(
		report.records.map(
			(row) => row[report.headers.indexOf("validation_status")],
		),
	).toEqual(["ready", "missing-link", "ready"]);
	expect(
		report.records.map(
			(row) => row[report.headers.indexOf("source_record_number")],
		),
	).toEqual(["1", "2", "3"]);
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.screenshot({
		path: testInfo.outputPath("migration-csv-preview.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page
		.getByText("Preview videos and full report", { exact: true })
		.click();
	await page.setViewportSize({ width: 480, height: 960 });
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.screenshot({
		path: testInfo.outputPath("migration-csv-ready-narrow.png"),
		fullPage: true,
		animations: "disabled",
	});
	expect(loomRequests.requests).toBeGreaterThan(0);
	expect(loomRequests.authorizationHeaders).toBe(0);
	expect(loomRequests.cookieHeaders).toBe(0);
	expect(server.state.contextRequests).toBe(0);
	expect(server.state.requests).toEqual([]);
	expect(server.state.batchRequests).toEqual([]);
});

test("account migration uses the Cap browser session for one acknowledged batch and opens its dashboard receipt", async ({
	harness,
}, testInfo) => {
	const { page, context, server, worker } = harness;
	const loomRequests = await routeNativeLoom(context, {
		csv: duplicateNativeLoomCsv,
	});
	await openMigration(harness);
	await seedCapCookieSession(harness);
	const loom = await prepareNativeLoom(harness);
	const from = await loom
		.getByLabel("Start date", { exact: true })
		.inputValue();
	const to = await loom.getByLabel("End date", { exact: true }).inputValue();
	expect(server.state.contextRequests).toBe(0);
	const cap = await connectCookieCap(harness);
	expect(server.state.batchRequests).toEqual([]);
	expect(server.state.requests).toEqual([]);
	const start = page.getByRole("button", {
		name: "Start import",
		exact: true,
	});
	await expect(start).toBeDisabled();
	const acknowledge = page.getByRole("checkbox", { name: /^I understand/ });
	await expect(acknowledge).not.toBeChecked();
	await acknowledge.check();
	await expect(start).toBeEnabled();
	await start.click();
	await expect.poll(() => server.state.batchRequests.length).toBe(1);
	await expect(cap).toHaveURL(
		`${server.origin}/dashboard/import/loom/status?operationId=fixturebatch001&organizationId=${organizationId}`,
	);
	await expect(
		page.getByRole("link", { name: "View import in dashboard", exact: true }),
	).toHaveAttribute("href", cap.url());
	await expect(start).toBeHidden();
	expect(server.state.batchRequests).toEqual([
		{
			requestId: expect.stringMatching(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
			),
			expectedUserId: userId,
			expectedDefaultPublic: false,
			organizationId,
			source: {
				workspace: loomWorkspace,
				from,
				to,
				totalRows: 3,
				omittedRows: 1,
			},
			rows: [
				{ rowNumber: 1, loomUrl: firstUrl, userEmail: "alex@example.test" },
				{ rowNumber: 2, loomUrl: secondUrl, userEmail: "casey@example.test" },
			],
		},
	]);
	await expandMigrationPreview(page);
	const report = parseInventory(
		await downloadCsv(
			page,
			testInfo,
			"Download full report",
			"cap-loom-inventory-report.csv",
		),
		"report.csv",
	);
	expect(report.records).toHaveLength(3);
	expect(
		report.records.map(
			(row) => row[report.headers.indexOf("validation_status")],
		),
	).toEqual(["ready", "ready", "duplicate"]);
	expect(await readNativeCaptureState(loom)).toEqual({
		exports: 1,
		createObjectURLRestored: true,
		anchorClickRestored: true,
	});
	expect(
		await worker.evaluate(async (key) => {
			const values = await chrome.storage.local.get(key);
			return values[key];
		}, authKey),
	).toBeNull();
	expect(loomRequests.requests).toBeGreaterThan(0);
	expect(loomRequests.authorizationHeaders).toBe(0);
	expect(loomRequests.cookieHeaders).toBe(0);
	expect(server.state.contextRequests).toBe(2);
	expect(server.state.cookieSessionRequests).toBe(3);
	expect(server.state.requests).toEqual([]);
});

test("a native Loom count mismatch stops preparation before contacting Cap", async ({
	harness,
}) => {
	const { page, server, context } = harness;
	await routeNativeLoom(context, { totalRows: 4 });
	await openMigration(harness);
	const loom = await connectNativeLoom(harness);
	await page.getByRole("button", { name: "Next", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Loom reported 4 videos but returned 3 records.",
	);
	await expect(
		page.getByRole("heading", { name: "Your CSV is ready", exact: true }),
	).toHaveCount(0);
	expect(server.state.batchRequests).toEqual([]);
	expect(server.state.requests).toEqual([]);
	expect(server.state.contextRequests).toBe(0);
	expect(await readNativeCaptureState(loom)).toEqual({
		exports: 1,
		createObjectURLRestored: true,
		anchorClickRestored: true,
	});
});

test("a Loom workspace change during native capture cannot be submitted to Cap", async ({
	harness,
}) => {
	const { page, server, context } = harness;
	await routeNativeLoom(context, {
		workspaceAfterDownload: "Another synthetic workspace",
	});
	await openMigration(harness);
	const loom = await connectNativeLoom(harness);
	await page.getByRole("button", { name: "Next", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Loom’s workspace or dates changed during capture. Nothing was imported.",
	);
	await expect(
		page.getByRole("heading", { name: "Your CSV is ready", exact: true }),
	).toHaveCount(0);
	expect(server.state.batchRequests).toEqual([]);
	expect(server.state.requests).toEqual([]);
	expect(server.state.contextRequests).toBe(0);
	expect(await readNativeCaptureState(loom)).toEqual({
		exports: 1,
		createObjectURLRestored: true,
		anchorClickRestored: true,
	});
});

test("changing the Cap dashboard account after connecting blocks the migration before its batch POST", async ({
	harness,
}) => {
	const { page, server, context } = harness;
	await routeNativeLoom(context);
	await openMigration(harness);
	const loom = await prepareNativeLoom(harness);
	const cap = await connectCookieCap(harness);
	server.state.context.user = {
		id: otherUserId,
		email: "changed-account@example.test",
	};
	await page.getByRole("checkbox", { name: /^I understand/ }).check();
	await page.getByRole("button", { name: "Start import", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"The Cap account changed. Reconnect before starting an import.",
	);
	await expect(
		page.getByRole("link", { name: "View import in dashboard", exact: true }),
	).toHaveCount(0);
	await expect(cap).toHaveURL(`${server.origin}/dashboard/caps`);
	expect(server.state.contextRequests).toBe(2);
	expect(server.state.batchRequests).toEqual([]);
	expect(server.state.requests).toEqual([]);
	expect(await readNativeCaptureState(loom)).toEqual({
		exports: 1,
		createObjectURLRestored: true,
		anchorClickRestored: true,
	});
});

test("Cap completes the batch handoff after the importer closes before the response arrives", async ({
	harness,
}) => {
	const { page, context, server, worker } = harness;
	await routeNativeLoom(context);
	await openMigration(harness);
	await prepareNativeLoom(harness);
	const cap = await connectCookieCap(harness);
	server.state.holdBatchRequests = true;
	await page.getByRole("checkbox", { name: /^I understand/ }).check();
	await page.getByRole("button", { name: "Start import", exact: true }).click();
	await expect.poll(() => server.state.batchRequests.length).toBe(1);
	await expect(cap).toHaveURL(`${server.origin}/dashboard/caps`);
	await expect
		.poll(() =>
			worker.evaluate(async () => {
				const [active] = await chrome.tabs.query({
					active: true,
					currentWindow: true,
				});
				return active?.url;
			}),
		)
		.toBe(`${server.origin}/dashboard/caps`);
	await page.close();
	server.releaseBatch(0);
	await expect(cap).toHaveURL(
		`${server.origin}/dashboard/import/loom/status?operationId=fixturebatch001&organizationId=${organizationId}`,
	);
	expect(server.state.batchRequests).toHaveLength(1);
	expect(server.state.requests).toEqual([]);
	expect(server.state.contextRequests).toBe(2);
	expect(server.state.cookieSessionRequests).toBe(3);
});

test("reloading an identical Loom workspace requires reconnection before capturing or importing", async ({
	harness,
}) => {
	const { page, context, server } = harness;
	await openMigration(harness);
	const from = await page.getByLabel("From", { exact: true }).inputValue();
	const to = await page.getByLabel("Through", { exact: true }).inputValue();
	await routeNativeLoom(context, { from, to });
	const loom = await connectNativeLoom(harness);
	const next = page.getByRole("button", {
		name: "Next",
		exact: true,
	});
	await expect(next).toBeEnabled();
	await loom.reload();
	await expect(loom.getByLabel("Start date", { exact: true })).toHaveValue(
		from,
	);
	await expect(loom.getByLabel("End date", { exact: true })).toHaveValue(to);
	await expect(
		loom.getByRole("button", { name: loomWorkspace, exact: true }),
	).toBeVisible();
	await expect(
		loom.getByText("Export all 3 videos created in this date range.", {
			exact: true,
		}),
	).toBeVisible();
	await expect(page.getByRole("alert")).toHaveText(
		"Loom navigated after connecting. Reconnect Loom before continuing.",
	);
	await expect(next).toBeHidden();
	await expect(
		page.getByRole("button", { name: "Connect Loom", exact: true }),
	).toBeEnabled();
	await expect(
		page.getByRole("button", { name: "Import to Cap", exact: true }),
	).toBeHidden();
	expect(await readNativeCaptureState(loom)).toEqual({
		exports: 0,
		createObjectURLRestored: true,
		anchorClickRestored: true,
	});
	await connectNativeLoom(harness);
	await expect(next).toBeEnabled();
	await next.click();
	await expect(
		page.getByRole("heading", { name: "Your CSV is ready", exact: true }),
	).toBeVisible();
	expect(await readNativeCaptureState(loom)).toEqual({
		exports: 1,
		createObjectURLRestored: true,
		anchorClickRestored: true,
	});
	expect(server.state.batchRequests).toEqual([]);
	expect(server.state.requests).toEqual([]);
	expect(server.state.contextRequests).toBe(0);
});

test("a changed visible Space link blocks capture while the Loom workspace label stays the same", async ({
	harness,
}) => {
	const { page, context, server } = harness;
	await routeNativeLoom(context);
	await openMigration(harness);
	const loom = await connectNativeLoom(harness);
	await loom
		.getByRole("link", { name: "Product guides", exact: true })
		.evaluate((anchor) =>
			anchor.setAttribute("href", "/spaces/fixture-other-guides"),
		);
	await expect(
		loom.getByRole("button", { name: loomWorkspace, exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "Next", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Loom’s workspace, visible Space links, dates or report count changed.",
	);
	await expect(
		page.getByRole("heading", { name: "Your CSV is ready", exact: true }),
	).toHaveCount(0);
	expect(await readNativeCaptureState(loom)).toEqual({
		exports: 0,
		createObjectURLRestored: true,
		anchorClickRestored: true,
	});
	expect(server.state.batchRequests).toEqual([]);
	expect(server.state.requests).toEqual([]);
	expect(server.state.contextRequests).toBe(0);
});

test("an active Loom-origin export lock prevents nested capture hooks and allows a later retry", async ({
	harness,
}) => {
	const { page, context, server } = harness;
	await routeNativeLoom(context);
	await openMigration(harness);
	const loom = await connectNativeLoom(harness);
	await loom.evaluate(
		() =>
			new Promise<void>((ready, reject) => {
				void navigator.locks
					.request(
						"cap-loom-native-export",
						() =>
							new Promise<void>((release) => {
								window.addEventListener(
									"fixture-release-export",
									() => release(),
									{ once: true },
								);
								ready();
							}),
					)
					.catch(reject);
			}),
	);
	const next = page.getByRole("button", {
		name: "Next",
		exact: true,
	});
	await next.click();
	await expect(page.getByRole("alert")).toHaveText(
		"Loom is already building a CSV for Cap. Wait for that export to finish before trying again.",
	);
	expect(await readNativeCaptureState(loom)).toEqual({
		exports: 0,
		createObjectURLRestored: true,
		anchorClickRestored: true,
	});
	await loom.evaluate(() =>
		window.dispatchEvent(new Event("fixture-release-export")),
	);
	await expect
		.poll(() =>
			loom.evaluate(async () => {
				const state = await navigator.locks.query();
				return state.held?.some(
					(lock) => lock.name === "cap-loom-native-export",
				);
			}),
		)
		.toBe(false);
	await next.click();
	await expect(
		page.getByRole("heading", { name: "Your CSV is ready", exact: true }),
	).toBeVisible();
	expect(await readNativeCaptureState(loom)).toEqual({
		exports: 1,
		createObjectURLRestored: true,
		anchorClickRestored: true,
	});
	expect(server.state.contextRequests).toBe(0);
	expect(server.state.batchRequests).toEqual([]);
	expect(server.state.requests).toEqual([]);
});

test("guided backward navigation preserves the prepared CSV and never submits without confirmation", async ({
	harness,
}, testInfo) => {
	const { page, context, server } = harness;
	await routeNativeLoom(context);
	await openMigration(harness);
	const loom = await prepareNativeLoom(harness);
	expect(server.state.contextRequests).toBe(0);
	const cap = await connectCookieCap(harness);
	const start = page.getByRole("button", { name: "Start import", exact: true });
	await expect(start).toBeDisabled();
	expect(server.state.batchRequests).toEqual([]);
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.screenshot({
		path: testInfo.outputPath("migration-destination-review.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.getByRole("button", { name: "Back", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Your CSV is ready", exact: true }),
	).toBeVisible();
	await expect(start).toBeHidden();
	await expect(
		page.getByRole("button", { name: "Download CSV", exact: true }),
	).toBeEnabled();
	await page.getByRole("button", { name: "Back to Loom", exact: true }).click();
	await expect(page.getByText(loomWorkspace, { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Next", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Your CSV is ready", exact: true }),
	).toBeVisible();
	expect(await readNativeCaptureState(loom)).toEqual({
		exports: 1,
		createObjectURLRestored: true,
		anchorClickRestored: true,
	});
	const sameCap = await connectCookieCap(harness);
	expect(sameCap).toBe(cap);
	await expect(start).toBeDisabled();
	await expect(
		page.getByRole("checkbox", { name: /^I understand/ }),
	).not.toBeChecked();
	expect(server.state.batchRequests).toEqual([]);
	expect(server.state.requests).toEqual([]);
});
