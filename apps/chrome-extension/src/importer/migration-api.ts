import type { ImportContext } from "./api";
import type { PreparedLoomCapture } from "./loom-capture";

export type CapMigrationConnection = {
	tabId: number;
	origin: string;
	context: ImportContext;
};

type CapPageRequest = {
	origin: string;
	method: "GET" | "POST";
	path: "/api/extension/import-loom" | "/api/extension/import-loom/batch";
	body?: unknown;
	handoffOrganizationId?: string;
};

export async function capPageRequest(request: CapPageRequest) {
	if (
		location.origin !== request.origin ||
		!location.pathname.startsWith("/dashboard") ||
		![
			"/api/extension/import-loom",
			"/api/extension/import-loom/batch",
		].includes(request.path)
	) {
		return { status: 401, body: null };
	}
	try {
		const response = await fetch(request.path, {
			method: request.method,
			credentials: "same-origin",
			redirect: "error",
			cache: "no-store",
			headers: { "Content-Type": "application/json" },
			body:
				request.body === undefined ? undefined : JSON.stringify(request.body),
			signal: AbortSignal.timeout(request.method === "POST" ? 60_000 : 15_000),
		});
		const body: unknown = await response.json().catch(() => null);
		if (response.ok && request.handoffOrganizationId !== undefined) {
			if (
				request.method !== "POST" ||
				request.path !== "/api/extension/import-loom/batch" ||
				!body ||
				typeof body !== "object" ||
				!("operationId" in body) ||
				typeof body.operationId !== "string" ||
				!("dashboardPath" in body) ||
				typeof body.dashboardPath !== "string"
			)
				return { status: 502, body: null };
			const dashboard = new URL(body.dashboardPath, request.origin);
			if (
				dashboard.origin !== request.origin ||
				dashboard.pathname !== "/dashboard/import/loom/status" ||
				dashboard.searchParams.get("operationId") !== body.operationId ||
				dashboard.searchParams.get("organizationId") !==
					request.handoffOrganizationId
			)
				return { status: 502, body: null };
			// Cap owns the redirect even if the extension closes after submitting.
			window.setTimeout(() => location.assign(dashboard.toString()), 250);
		}
		return { status: response.status, body };
	} catch {
		return { status: 0, body: null };
	}
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

async function inCapTab(tabId: number, request: CapPageRequest) {
	const results = await chrome.scripting.executeScript({
		target: { tabId },
		world: "MAIN",
		func: capPageRequest,
		args: [request],
	});
	const result = results.find((frame) => frame.frameId === 0)?.result;
	if (!result || result.status === 0) {
		throw new Error(
			"Cap did not confirm the request. Keep the dashboard tab open. Retrying this capture uses the same request ID.",
		);
	}
	if (result.status < 200 || result.status >= 300) {
		const messages: Record<number, string> = {
			400: "Cap rejected this batch or the signed-in account changed. Reconnect Cap before trying again.",
			401: "Sign in to Cap in its dashboard tab, then click Connect Cap again.",
			403: "Importing requires Cap Pro and an organization admin or owner role.",
			404: "This Cap server does not have the automatic Loom importer yet. The web changes need to be deployed before importing; CSV-only still works.",
			409: "Another Loom batch is already active for this organization. Check the Cap dashboard before trying again.",
		};
		throw new Error(
			messages[result.status] ??
				"Cap could not queue this batch. Check the dashboard before retrying.",
		);
	}
	return result.body;
}

export async function readCapContext(
	tabId: number,
	origin: string,
): Promise<ImportContext> {
	const data = await inCapTab(tabId, {
		origin,
		method: "GET",
		path: "/api/extension/import-loom",
	});
	if (
		!isObject(data) ||
		!isObject(data.user) ||
		typeof data.user.id !== "string" ||
		typeof data.user.email !== "string" ||
		!Array.isArray(data.organizations) ||
		!data.organizations.every(
			(org: unknown) =>
				isObject(org) &&
				typeof org.id === "string" &&
				typeof org.name === "string" &&
				typeof org.canImport === "boolean",
		) ||
		typeof data.isPro !== "boolean" ||
		typeof data.defaultPublic !== "boolean" ||
		typeof data.activeOrganizationId !== "string" ||
		typeof data.maxRows !== "number"
	) {
		throw new Error("Cap returned an unexpected importer configuration.");
	}
	return data as ImportContext;
}

export function capOrigin(apiBaseUrl: string) {
	const url = new URL(apiBaseUrl);
	if (
		url.username ||
		url.password ||
		(url.protocol !== "https:" &&
			!(
				url.protocol === "http:" &&
				["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
			))
	)
		throw new Error(
			"Set a secure Cap URL in the extension Options before connecting.",
		);
	return url.origin;
}

export async function openCapDashboard(origin: string) {
	const tabs = await chrome.tabs.query({ url: `${origin}/*` });
	const existing = tabs.find((tab) => {
		try {
			return new URL(tab.url ?? "").pathname.startsWith("/dashboard");
		} catch {
			return false;
		}
	});
	const tab = existing?.id
		? await chrome.tabs.update(existing.id, { active: true })
		: await chrome.tabs.create({
				url: `${origin}/dashboard/caps`,
				active: true,
			});
	if (tab?.id === undefined)
		throw new Error("Could not open the Cap dashboard.");
	return tab.id;
}

export async function queueLoomCapture(
	connection: CapMigrationConnection,
	organizationId: string,
	capture: PreparedLoomCapture,
) {
	if (!capture.eligible.length)
		throw new Error(
			"Loom did not expose any importable links. Download the full report to review the omissions.",
		);
	if (capture.eligible.length > 5_000)
		throw new Error(
			"Automatic imports are limited to 5,000 available videos per batch. Narrow the date range and reconnect Loom.",
		);
	const current = await readCapContext(connection.tabId, connection.origin);
	if (current.user.id !== connection.context.user.id)
		throw new Error(
			"The Cap account changed. Reconnect before starting an import.",
		);
	if (
		!current.isPro ||
		!current.organizations.some(
			(org) => org.id === organizationId && org.canImport,
		)
	) {
		throw new Error(
			"You no longer have permission to import into this organization.",
		);
	}
	if (current.defaultPublic !== connection.context.defaultPublic) {
		throw new Error(
			"Cap’s default video visibility changed. Reconnect and review it before importing.",
		);
	}
	const payload = {
		expectedUserId: current.user.id,
		expectedDefaultPublic: current.defaultPublic,
		organizationId,
		rows: capture.eligible.map((row) => ({
			rowNumber: row.sourceRecord,
			loomUrl: row.url,
			userEmail: row.ownerEmail,
		})),
		source: { ...capture.source, omittedRows: capture.omittedRows },
	};
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			JSON.stringify({ origin: connection.origin, ...payload }),
		),
	);
	const key = `cap-loom-batch:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
	let requestId = localStorage.getItem(key);
	if (!requestId || !/^[0-9a-f-]{36}$/i.test(requestId)) {
		requestId = crypto.randomUUID();
		localStorage.setItem(key, requestId);
	}
	await chrome.tabs.update(connection.tabId, { active: true });
	const data = await inCapTab(connection.tabId, {
		origin: connection.origin,
		method: "POST",
		path: "/api/extension/import-loom/batch",
		body: { requestId, ...payload },
		handoffOrganizationId: organizationId,
	});
	if (
		!isObject(data) ||
		typeof data.operationId !== "string" ||
		typeof data.dashboardPath !== "string"
	) {
		throw new Error(
			"Cap did not return a batch receipt. Retrying uses the same request ID.",
		);
	}
	const dashboard = new URL(data.dashboardPath, connection.origin);
	if (
		dashboard.origin !== connection.origin ||
		dashboard.pathname !== "/dashboard/import/loom/status" ||
		dashboard.searchParams.get("operationId") !== data.operationId ||
		dashboard.searchParams.get("organizationId") !== organizationId
	)
		throw new Error(
			"Cap returned an invalid dashboard link. No redirect was followed.",
		);
	return { operationId: data.operationId, dashboardUrl: dashboard.toString() };
}
