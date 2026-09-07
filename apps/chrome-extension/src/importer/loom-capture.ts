import {
	buildInventory,
	detectColumns,
	exportImportCsv,
	exportInventoryCsv,
	parseInventory,
} from "./inventory";

export type LoomExportSource = {
	workspace: string;
	from: string;
	to: string;
	totalRows: number;
};

export type LoomExportState =
	| { status: "ready"; source: LoomExportSource; visibleSpaceLinks: string[] }
	| { status: "unavailable"; message: string };

type LoomExportCommand =
	| { type: "inspect" }
	| { type: "range"; from: string; to: string }
	| {
			type: "capture";
			expected: LoomExportSource;
			visibleSpaceLinks: string[];
	  };

type LoomExportResult = LoomExportState | { status: "captured"; csv: string };

export async function loomExportBridge(
	command: LoomExportCommand,
): Promise<LoomExportResult> {
	const unavailable = (message: string): LoomExportResult => ({
		status: "unavailable",
		message,
	});
	if (
		location.origin !== "https://www.loom.com" ||
		location.pathname !== "/settings/workspace" ||
		location.hash !== "#data"
	) {
		return unavailable(
			"Open Loom’s Workspace settings → Data while signed in.",
		);
	}
	const visible = (element: Element): element is HTMLElement =>
		element instanceof HTMLElement &&
		element.getClientRects().length > 0 &&
		getComputedStyle(element).visibility !== "hidden";
	const text = (element: Element) =>
		(element.textContent ?? "").trim().replace(/\s+/g, " ");
	const buttons = (root: Element) =>
		[...root.querySelectorAll("button, [role=button]")].filter(
			(element) => visible(element) && text(element) === "Download CSV",
		);
	const headings = [...document.querySelectorAll("h1, h2, h3, [role=heading]")];
	const readWorkspace = () => {
		const settingsHeading = [
			...document.querySelectorAll("h1, [role=heading]"),
		].find(
			(element) =>
				visible(element) && /^Workspace Settings\b/.test(text(element)),
		);
		if (!settingsHeading) return null;
		const walker = document.createTreeWalker(
			document.body,
			NodeFilter.SHOW_TEXT,
		);
		let previous = "";
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (settingsHeading.contains(node)) break;
			const value = node.textContent?.trim().replace(/\s+/g, " ") ?? "";
			if (
				node.parentElement &&
				visible(node.parentElement) &&
				value &&
				!/^[\s/>›·]+$/.test(value)
			)
				previous = value;
		}
		if (!previous || previous.length > 255) return null;
		return [...document.querySelectorAll("button, [role=button]")].some(
			(element) => visible(element) && text(element) === previous,
		)
			? previous
			: null;
	};
	const heading = headings.find(
		(element) =>
			visible(element) && text(element) === "Export engagement insights",
	);
	if (!heading) {
		return unavailable(
			"Loom’s engagement export is not available yet. Wait for the page to load. This export requires a Loom workspace admin on Business, Business + AI or Enterprise.",
		);
	}
	const readVisibleSpaceLinks = () =>
		[
			...new Set(
				[...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
					.filter(
						(anchor) =>
							visible(anchor) &&
							Boolean(
								anchor.compareDocumentPosition(heading) &
									Node.DOCUMENT_POSITION_FOLLOWING,
							),
					)
					.flatMap((anchor) => {
						const url = new URL(anchor.href);
						return url.origin === "https://www.loom.com" &&
							url.pathname.startsWith("/spaces/")
							? [`${url.origin}${url.pathname}`]
							: [];
					}),
			),
		].sort();
	let section: HTMLElement | null = heading.parentElement;
	while (
		section &&
		(buttons(section).length !== 1 ||
			section.querySelectorAll('input[type="date"]').length !== 2)
	) {
		section = section.parentElement;
	}
	if (
		!section ||
		section === document.body ||
		section === document.documentElement
	) {
		return unavailable(
			"Loom’s export controls have changed. No export was started.",
		);
	}
	const dates = [
		...section.querySelectorAll<HTMLInputElement>('input[type="date"]'),
	];
	const dateNamed = (name: string) =>
		dates.find(
			(input) =>
				visible(input) &&
				(input.getAttribute("aria-label") === name ||
					[...(input.labels ?? [])].some((label) => text(label) === name)),
		);
	const from = dateNamed("Start date");
	const to = dateNamed("End date");
	const button = buttons(section)[0];
	if (!from || !to || !(button instanceof HTMLButtonElement)) {
		return unavailable(
			"Could not identify Loom’s date filters and export button safely.",
		);
	}
	if (command.type === "range") {
		const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
		if (
			!validDate(command.from) ||
			!validDate(command.to) ||
			command.from > command.to
		) {
			return unavailable("Choose a valid export date range.");
		}
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		if (!setter)
			return unavailable("Could not set Loom’s export date filters.");
		for (const [input, value] of [
			[from, command.from],
			[to, command.to],
		] as const) {
			setter.call(input, value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
		}
		return unavailable("Updating Loom’s report date range…");
	}
	const count = text(section).match(/(?:all\s+)?([\d,]+)\s+videos?\s+created/i);
	const totalRows = count ? Number(count[1]?.replaceAll(",", "")) : Number.NaN;
	// Loom's "Workspace" CSV column is an access level, not the workspace name.
	const workspace = readWorkspace();
	if (
		!Number.isSafeInteger(totalRows) ||
		totalRows < 0 ||
		totalRows > 50_000 ||
		!/^\d{4}-\d{2}-\d{2}$/.test(from.value) ||
		!/^\d{4}-\d{2}-\d{2}$/.test(to.value)
	) {
		return unavailable(
			"Loom’s report count or dates could not be verified. Nothing was imported.",
		);
	}
	if (totalRows === 0)
		return unavailable(
			"Loom reports no videos in this workspace for these dates.",
		);
	if (!workspace) {
		return unavailable(
			"Could not verify the workspace name against Loom’s visible breadcrumb and workspace selector.",
		);
	}
	if (button.disabled || button.getAttribute("aria-disabled") === "true") {
		return unavailable(
			"Loom is still preparing the report. Try again in a moment.",
		);
	}
	const source: LoomExportSource = {
		workspace,
		from: from.value,
		to: to.value,
		totalRows,
	};
	const visibleSpaceLinks = readVisibleSpaceLinks();
	if (command.type === "inspect")
		return { status: "ready", source, visibleSpaceLinks };
	if (
		source.workspace !== command.expected.workspace ||
		source.from !== command.expected.from ||
		source.to !== command.expected.to ||
		source.totalRows !== command.expected.totalRows ||
		JSON.stringify(visibleSpaceLinks) !==
			JSON.stringify(command.visibleSpaceLinks)
	) {
		return unavailable(
			"Loom’s workspace, visible Space links, dates or report count changed. Reconnect Loom before continuing.",
		);
	}
	return navigator.locks.request(
		"cap-loom-native-export",
		{ ifAvailable: true },
		async (lock) => {
			if (!lock)
				return unavailable(
					"Loom is already building a CSV for Cap. Wait for that export to finish before trying again.",
				);
			const originalCreate = URL.createObjectURL;
			const originalClick = HTMLAnchorElement.prototype.click;
			let finish: (result: LoomExportResult) => void = () => {};
			let settled = false;
			let directDownload = false;
			let timer = 0;
			const result = new Promise<LoomExportResult>((resolve) => {
				finish = (value) => {
					if (settled) return;
					settled = true;
					resolve(value);
				};
			});
			const inspectBlob = async (blob: Blob) => {
				if (settled || blob.size === 0 || blob.size > 10 * 1024 * 1024) return;
				if (
					blob.type &&
					!/^(text\/|application\/(csv|octet-stream))/.test(blob.type)
				)
					return;
				try {
					const csv = await blob.text();
					const header = csv.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
					if (
						["Video Link", "Video Name", "Creator Email", "Workspace"].every(
							(name) => header.includes(name),
						)
					) {
						if (
							readWorkspace() !== source.workspace ||
							!document.contains(heading) ||
							JSON.stringify(readVisibleSpaceLinks()) !==
								JSON.stringify(command.visibleSpaceLinks) ||
							!document.contains(from) ||
							!document.contains(to) ||
							from.value !== source.from ||
							to.value !== source.to ||
							location.origin !== "https://www.loom.com" ||
							location.pathname !== "/settings/workspace" ||
							location.hash !== "#data"
						) {
							finish(
								unavailable(
									"Loom’s workspace or dates changed during capture. Nothing was imported. Reconnect Loom before continuing.",
								),
							);
						} else {
							finish({ status: "captured", csv });
						}
					}
				} catch {
					finish(
						unavailable(
							"Could not read the CSV produced by Loom. Nothing was imported.",
						),
					);
				}
			};
			const createObjectURL: typeof URL.createObjectURL = (object) => {
				const url = originalCreate.call(URL, object);
				if (object instanceof Blob) void inspectBlob(object);
				return url;
			};
			const click = function (this: HTMLAnchorElement) {
				if (
					this.download &&
					this.href.startsWith("blob:https://www.loom.com/")
				) {
					void fetch(this.href)
						.then((response) => response.blob())
						.then(inspectBlob)
						.catch(() => {});
				} else if (this.download && this.href.startsWith("https:")) {
					directDownload = true;
				}
				originalClick.call(this);
			};
			const leaving = () =>
				finish(
					unavailable("The Loom page navigated away before capture finished."),
				);
			try {
				URL.createObjectURL = createObjectURL;
				HTMLAnchorElement.prototype.click = click;
				window.addEventListener("pagehide", leaving, { once: true });
				timer = window.setTimeout(
					() =>
						finish(
							unavailable(
								directDownload
									? "Loom downloaded a file but did not expose CSV bytes to this capture. Nothing was imported. You can use the CSV file tool instead."
									: "Loom did not produce a readable CSV within 90 seconds. Nothing was imported.",
							),
						),
					90_000,
				);
				button.click();
				return await result;
			} finally {
				window.clearTimeout(timer);
				window.removeEventListener("pagehide", leaving);
				if (URL.createObjectURL === createObjectURL)
					URL.createObjectURL = originalCreate;
				if (HTMLAnchorElement.prototype.click === click)
					HTMLAnchorElement.prototype.click = originalClick;
			}
		},
	);
}

export async function openLoomExport(): Promise<number> {
	const tabs = await chrome.tabs.query({
		url: "https://www.loom.com/settings/workspace*",
	});
	const existing = tabs.find(
		(tab) => tab.url === "https://www.loom.com/settings/workspace#data",
	);
	const tab = existing?.id
		? await chrome.tabs.update(existing.id, { active: true })
		: await chrome.tabs.create({
				url: "https://www.loom.com/settings/workspace#data",
				active: true,
			});
	if (tab?.id === undefined)
		throw new Error("Could not open Loom’s export page.");
	return tab.id;
}

export async function runLoomExport(
	tabId: number,
	command: LoomExportCommand,
	documentId?: string,
) {
	const results = await chrome.scripting.executeScript({
		target: { tabId, ...(documentId ? { documentIds: [documentId] } : {}) },
		world: "MAIN",
		func: loomExportBridge,
		args: [command],
	});
	const frame = results.find((frame) => frame.frameId === 0);
	if (!frame?.result || !frame.documentId)
		throw new Error(
			"Could not read Loom. Keep its signed-in Data page open and try again.",
		);
	return { ...frame.result, documentId: frame.documentId };
}

export function prepareLoomCapture(csv: string, source: LoomExportSource) {
	const table = parseInventory(csv, "loom-account.csv");
	for (const name of [
		"Video Link",
		"Video Name",
		"Creator Email",
		"Workspace",
		"Folder",
		"Video Creation Date",
	]) {
		if (!table.headers.includes(name))
			throw new Error("Loom’s CSV format has changed. No import was started.");
	}
	if (table.records.length !== source.totalRows) {
		throw new Error(
			`Loom reported ${source.totalRows} videos but returned ${table.records.length} records. Reconnect and try again; no import was started.`,
		);
	}
	const mapping = detectColumns(table.headers);
	mapping.createdAt = table.headers.indexOf("Video Creation Date");
	const rows = buildInventory(table, mapping, {
		ownerMode: "column",
		ownerEmail: "",
		spaceMode: "none",
		spaceName: "",
	});
	const eligible = rows.filter((row) => !row.issue && !row.reviewRequired);
	return {
		source,
		table,
		rows,
		eligible,
		omittedRows: rows.length - eligible.length,
		importCsv: exportImportCsv(eligible),
		reportCsv: exportInventoryCsv(table, rows),
	};
}

export type PreparedLoomCapture = ReturnType<typeof prepareLoomCapture>;
