import {
	ArrowLeftIcon,
	ArrowRightIcon,
	CheckCircle2Icon,
	ChevronDownIcon,
	DownloadIcon,
	ShieldCheckIcon,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CapBrand, DoodleBoilFilter } from "../shared/cap-brand";
import { mountPageNav } from "../shared/page-nav";
import { defaultSettings, loadSettings, SETTINGS_KEY } from "../shared/storage";
import { InventoryTable } from "./inventory-table";
import {
	type LoomExportSource,
	openLoomExport,
	type PreparedLoomCapture,
	prepareLoomCapture,
	runLoomExport,
} from "./loom-capture";
import {
	type CapMigrationConnection,
	capOrigin,
	openCapDashboard,
	queueLoomCapture,
	readCapContext,
} from "./migration-api";
import "./migration.css";

const pause = (milliseconds: number) =>
	new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
const errorMessage = (error: unknown) =>
	error instanceof Error
		? error.message
		: "Could not complete this step. Please try again.";
const ignoreSelection = () => {};
const emptyOutcomes = {};
const focusHeading = (node: HTMLHeadingElement | null) =>
	node?.focus({ preventScroll: true });
type MigrationView = "connect" | "ready" | "destination";

function MigrationDoodle({ mode }: { mode: MigrationView | "complete" }) {
	return (
		<svg className="doodle" viewBox="0 0 120 104" aria-hidden="true">
			<defs>
				<DoodleBoilFilter />
			</defs>
			<g className="doodle-boil" key={mode}>
				{mode === "connect" ? (
					<g
						className="migration-link-doodle"
						transform="translate(-5 -10) scale(2.2)"
					>
						<path
							className="doodle-stroke migration-draw"
							pathLength={1}
							d="M 21 27 l -5 5 a 6.5 6.5 0 0 0 9.2 9.2 l 5 -5"
						/>
						<path
							className="doodle-stroke migration-draw migration-draw-later"
							pathLength={1}
							d="M 27 21 l 5 -5 a 6.5 6.5 0 0 1 9.2 9.2 l -5 5"
						/>
						<path
							className="doodle-stroke migration-draw migration-accent"
							pathLength={1}
							d="M 20 37 L 37 20"
						/>
					</g>
				) : mode === "destination" ? (
					<g className="migration-cloud">
						<path
							className="doodle-stroke migration-draw"
							pathLength={1}
							d="M 34 58 L 88 58 C 98 58 106 50 106 41 C 106 32 98.5 25 89.5 25 C 86.5 25 84 25.7 81.8 27 C 79 16.5 69.5 9 58.5 9 C 47 9 37.5 16.8 34.8 27.5 C 25.2 28 17.5 35.4 17.5 44 C 17.5 52 24.8 58 34 58 Z"
						/>
						<path
							className="doodle-stroke migration-accent migration-cloud-arrow"
							d="M 60 92 L 60 68 M 49 78 L 60 66 L 71 78"
						/>
					</g>
				) : (
					<path
						className="doodle-stroke migration-draw"
						pathLength={1}
						d="M 34 58 L 52 76 L 90 30"
					/>
				)}
				<path
					className="spark migration-spark-first"
					d="M 20 12 L 20 18 M 20 26 L 20 32 M 10 22 L 16 22 M 24 22 L 30 22"
				/>
				<path
					className="spark migration-spark-last"
					d="M 103 66 L 103 71 M 103 79 L 103 84 M 94 75 L 99 75 M 107 75 L 112 75"
				/>
			</g>
		</svg>
	);
}

function downloadCsv(filename: string, content: string) {
	const url = URL.createObjectURL(
		new Blob([content], { type: "text/csv;charset=utf-8" }),
	);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function Migration() {
	const headingId = useId();
	const [view, setView] = useState<MigrationView>("connect");
	const [settings, setSettings] = useState(defaultSettings);
	const [settingsReady, setSettingsReady] = useState(false);
	const [from, setFrom] = useState("1970-01-01");
	const [to, setTo] = useState(() => {
		const now = new Date();
		return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	});
	const [source, setSource] = useState<LoomExportSource | null>(null);
	const [loomTabId, setLoomTabId] = useState<number | null>(null);
	const [loomDocumentId, setLoomDocumentId] = useState<string | null>(null);
	const [loomSpaceLinks, setLoomSpaceLinks] = useState<string[] | null>(null);
	const [connection, setConnection] = useState<CapMigrationConnection | null>(
		null,
	);
	const [organizationId, setOrganizationId] = useState("");
	const [capture, setCapture] = useState<PreparedLoomCapture | null>(null);
	const [accepted, setAccepted] = useState(false);
	const [busy, setBusy] = useState<"loom" | "cap" | "csv" | "import" | null>(
		null,
	);
	const [status, setStatus] = useState("");
	const [error, setError] = useState("");
	const [receipt, setReceipt] = useState<{
		operationId: string;
		dashboardUrl: string;
	} | null>(null);
	const currentTab = useRef<number | null>(null);
	const settingsVersion = useRef(0);
	const busyRef = useRef(false);
	const mounted = useRef(true);
	const selected = useMemo(
		() => new Set(capture?.eligible.map((row) => row.sourceRecord) ?? []),
		[capture],
	);
	const destination = connection?.context.organizations.find(
		(org) => org.id === organizationId,
	);
	const canImport = Boolean(
		connection?.context.isPro &&
			destination?.canImport &&
			capture?.eligible.length &&
			accepted &&
			!receipt,
	);
	const mode = receipt ? "complete" : view;
	const title = receipt
		? "Your videos are on their way"
		: view === "connect"
			? "Move your Loom library to Cap"
			: view === "ready"
				? "Your CSV is ready"
				: "Import to Cap";

	useEffect(() => {
		mounted.current = true;
		void chrome.tabs.getCurrent().then((tab) => {
			currentTab.current = tab?.id ?? null;
		});
		const refresh = async () => {
			try {
				const next = await loadSettings();
				if (mounted.current) {
					setSettings(next);
					setSettingsReady(true);
				}
			} catch (caught) {
				if (mounted.current) setError(errorMessage(caught));
			}
		};
		void refresh();
		const changed = (
			changes: Record<string, chrome.storage.StorageChange>,
			area: string,
		) => {
			if (area !== "local" || !changes[SETTINGS_KEY]) return;
			settingsVersion.current += 1;
			setConnection(null);
			setAccepted(false);
			void refresh();
		};
		chrome.storage.onChanged.addListener(changed);
		return () => {
			mounted.current = false;
			chrome.storage.onChanged.removeListener(changed);
		};
	}, []);
	useEffect(() => {
		if (loomTabId === null || !loomDocumentId || capture) return;
		const navigated = (tabId: number, change: chrome.tabs.TabChangeInfo) => {
			if (
				tabId !== loomTabId ||
				(change.status !== "loading" && change.url === undefined)
			)
				return;
			setSource(null);
			setLoomDocumentId(null);
			setLoomSpaceLinks(null);
			setAccepted(false);
			setError(
				"Loom navigated after connecting. Reconnect Loom before continuing.",
			);
		};
		chrome.tabs.onUpdated.addListener(navigated);
		return () => chrome.tabs.onUpdated.removeListener(navigated);
	}, [loomTabId, loomDocumentId, capture]);

	async function focusImporter() {
		if (currentTab.current !== null && mounted.current) {
			await chrome.tabs
				.update(currentTab.current, { active: true })
				.catch(() => {});
		}
	}

	async function exclusive(
		kind: NonNullable<typeof busy>,
		action: () => Promise<void>,
	) {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(kind);
		setError("");
		try {
			await navigator.locks.request(
				"cap-loom-account-migration",
				{ ifAvailable: true },
				async (lock) => {
					if (!lock)
						throw new Error(
							"Another Cap migration tab is working. Wait for it to finish before continuing.",
						);
					await action();
				},
			);
		} catch (caught) {
			setStatus("");
			setError(errorMessage(caught));
			await focusImporter();
		} finally {
			busyRef.current = false;
			if (mounted.current) setBusy(null);
		}
	}

	const connectLoom = () =>
		exclusive("loom", async () => {
			setSource(null);
			setLoomDocumentId(null);
			setLoomSpaceLinks(null);
			setCapture(null);
			setAccepted(false);
			setStatus("Opening Loom’s workspace export…");
			const tabId = await openLoomExport();
			setLoomTabId(tabId);
			try {
				let lastMessage =
					"Sign in to Loom, then return here and click Connect Loom again.";
				let rangeSet = false;
				for (let attempt = 0; attempt < 30 && mounted.current; attempt++) {
					await pause(500);
					try {
						if (!rangeSet) {
							const result = await runLoomExport(tabId, {
								type: "range",
								from,
								to,
							});
							if (
								result.status === "unavailable" &&
								result.message === "Updating Loom’s report date range…"
							) {
								rangeSet = true;
								await pause(1_500);
							} else if (result.status === "unavailable")
								lastMessage = result.message;
						}
						if (!rangeSet) continue;
						const result = await runLoomExport(tabId, { type: "inspect" });
						if (
							result.status === "ready" &&
							result.source.from === from &&
							result.source.to === to
						) {
							setSource(result.source);
							setLoomDocumentId(result.documentId);
							setLoomSpaceLinks(result.visibleSpaceLinks);
							setStatus(
								`Connected to ${result.source.workspace}. Ready to build the CSV.`,
							);
							return;
						}
						if (result.status === "unavailable") lastMessage = result.message;
					} catch (caught) {
						lastMessage = errorMessage(caught);
					}
				}
				throw new Error(lastMessage);
			} finally {
				await focusImporter();
			}
		});

	const connectCap = () =>
		exclusive("cap", async () => {
			setConnection(null);
			setAccepted(false);
			setStatus("Checking your Cap dashboard session…");
			const version = settingsVersion.current;
			const origin = capOrigin(settings.apiBaseUrl);
			const tabId = await openCapDashboard(origin);
			try {
				let failure =
					"Sign in to Cap in the dashboard tab, then connect again.";
				for (let attempt = 0; attempt < 16 && mounted.current; attempt++) {
					await pause(500);
					try {
						const context = await readCapContext(tabId, origin);
						if (version !== settingsVersion.current)
							throw new Error("The Cap URL changed. Connect again.");
						setConnection({ tabId, origin, context });
						setOrganizationId(context.activeOrganizationId);
						setStatus(`Connected to Cap as ${context.user.email}.`);
						return;
					} catch (caught) {
						failure = errorMessage(caught);
						if (
							failure.includes("deployed") ||
							version !== settingsVersion.current
						)
							break;
					}
				}
				throw new Error(failure);
			} finally {
				await focusImporter();
			}
		});

	const prepareCsv = () =>
		exclusive("csv", async () => {
			if (capture) {
				setView("ready");
				setStatus("CSV ready. Nothing has been imported into Cap.");
				return;
			}
			if (!source || loomTabId === null || !loomDocumentId || !loomSpaceLinks)
				throw new Error("Connect your Loom workspace first.");
			setStatus("Preparing your videos. This can take up to 90 seconds…");
			const result = await runLoomExport(
				loomTabId,
				{
					type: "capture",
					expected: source,
					visibleSpaceLinks: loomSpaceLinks,
				},
				loomDocumentId,
			);
			if (result.status !== "captured")
				throw new Error(
					result.status === "unavailable"
						? result.message
						: "Loom did not return a CSV.",
				);
			setCapture(prepareLoomCapture(result.csv, source));
			setView("ready");
			setStatus("CSV ready. Nothing has been imported into Cap.");
			await focusImporter();
		});

	const startImport = () =>
		exclusive("import", async () => {
			if (!canImport || !connection || !capture || !mounted.current)
				throw new Error(
					"Connect Cap and review the destination before importing.",
				);
			setStatus(
				`Queueing ${capture.eligible.length.toLocaleString()} available videos in Cap…`,
			);
			const queued = await queueLoomCapture(
				connection,
				organizationId,
				capture,
			);
			setReceipt(queued);
			setStatus("Your import is running on Cap. You can close this tab.");
			await chrome.tabs.update(connection.tabId, { active: true }).catch(() => {
				setError(
					"The import was queued, but the dashboard tab could not be opened. Use the link below; do not start another import.",
				);
			});
		});

	const goBack = (next: MigrationView) => {
		setView(next);
		setAccepted(false);
		setError("");
		setStatus(
			next === "ready" ? "CSV ready. Nothing has been imported into Cap." : "",
		);
	};

	const clearSource = () => {
		setSource(null);
		setLoomDocumentId(null);
		setLoomSpaceLinks(null);
		setCapture(null);
		setAccepted(false);
		setError("");
		setStatus("");
	};

	return (
		<>
			<main className="stage migration-stage" aria-labelledby={headingId}>
				<header className="brand">
					<CapBrand />
				</header>
				<div className="migration-screen" key={mode} data-busy={Boolean(busy)}>
					<MigrationDoodle mode={mode} />
					<h1 id={headingId} ref={focusHeading} tabIndex={-1}>
						{title}
					</h1>
					<p className="lede">
						{receipt
							? "The import will keep running in Cap. Follow its progress from your dashboard."
							: view === "connect"
								? "Connect Loom, then download your CSV or bring your videos into Cap."
								: view === "ready"
									? "Your videos, ready for their next home. Download a copy or let Cap take it from here."
									: "Confirm where your videos should go. We’ll start the import and take you to your dashboard."}
					</p>
					<ol className="migration-steps" aria-label="Import steps">
						<li
							aria-current={view === "connect" && !receipt ? "step" : undefined}
						>
							<span
								className={
									source ? "migration-step-done" : "migration-step-current"
								}
							>
								{source ? <CheckCircle2Icon size={15} aria-hidden /> : "1"}
							</span>
							Connect Loom
						</li>
						<li
							aria-current={view !== "connect" || receipt ? "step" : undefined}
						>
							<span className={capture ? "migration-step-current" : ""}>2</span>
							Your videos
						</li>
					</ol>

					{receipt ? (
						<div className="card migration-panel migration-finished">
							<p>Your import is running on Cap. You can close this tab.</p>
							<a
								className="cta"
								href={receipt.dashboardUrl}
								target="_blank"
								rel="noopener noreferrer"
							>
								View import in dashboard{" "}
								<ArrowRightIcon size={16} aria-hidden />
							</a>
						</div>
					) : view === "connect" ? (
						<section className="card migration-panel" aria-label="Connect Loom">
							<div className="migration-connection">
								<div>
									<strong>{source?.workspace ?? "Your Loom account"}</strong>
									<p>
										{source
											? `${source.totalRows.toLocaleString()} source records · ready to prepare`
											: "Use the account signed in to this browser."}
									</p>
								</div>
								{source && (
									<CheckCircle2Icon
										className="migration-connected"
										size={22}
										aria-label="Loom connected"
									/>
								)}
							</div>
							<div className="migration-actions">
								{source ? (
									<>
										<button
											type="button"
											className="cta"
											disabled={Boolean(busy)}
											onClick={() => void prepareCsv()}
										>
											{busy === "csv" ? "Preparing…" : "Next"}{" "}
											<ArrowRightIcon size={16} aria-hidden />
										</button>
										<button
											type="button"
											className="migration-text-button"
											disabled={Boolean(busy)}
											onClick={() => void connectLoom()}
										>
											Reconnect Loom
										</button>
									</>
								) : (
									<button
										type="button"
										className="cta"
										disabled={Boolean(busy || !from || !to || from > to)}
										onClick={() => void connectLoom()}
									>
										{busy === "loom" ? "Connecting…" : "Connect Loom"}{" "}
										<ArrowRightIcon size={16} aria-hidden />
									</button>
								)}
							</div>
							<details className="migration-options">
								<summary>
									Export options <ChevronDownIcon size={14} aria-hidden />
								</summary>
								<p>
									All dates are included by default. Choose a shorter range if
									you prefer.
								</p>
								<div className="migration-dates">
									<label className="field">
										<span>From</span>
										<input
											type="date"
											value={from}
											disabled={Boolean(busy)}
											onChange={(event) => {
												setFrom(event.target.value);
												clearSource();
											}}
										/>
									</label>
									<label className="field">
										<span>Through</span>
										<input
											type="date"
											value={to}
											disabled={Boolean(busy)}
											onChange={(event) => {
												setTo(event.target.value);
												clearSource();
											}}
										/>
									</label>
								</div>
								<p>
									Loom workspace exports require an admin on a paid Loom plan.
								</p>
								{loomTabId !== null && (
									<button
										type="button"
										className="migration-text-button"
										disabled={Boolean(busy)}
										onClick={() =>
											void chrome.tabs
												.update(loomTabId, { active: true })
												.catch(() =>
													setError("The Loom tab was closed. Connect again."),
												)
										}
									>
										Open Loom tab
									</button>
								)}
							</details>
						</section>
					) : view === "ready" && capture ? (
						<section
							className="card migration-panel"
							aria-label="Choose what happens next"
						>
							<div className="migration-library">
								<h2>{capture.source.workspace}</h2>
								<div className="migration-stats">
									<div>
										<strong>{capture.rows.length.toLocaleString()}</strong>
										<span>Source records</span>
									</div>
									<div>
										<strong>{capture.eligible.length.toLocaleString()}</strong>
										<span>Ready to import</span>
									</div>
									<div>
										<strong>{capture.omittedRows.toLocaleString()}</strong>
										<span>Skipped</span>
									</div>
								</div>
							</div>
							<div className="migration-actions migration-choices">
								<button
									type="button"
									className="cta ghost"
									disabled={!capture.eligible.length}
									onClick={() =>
										downloadCsv("cap-loom-import.csv", capture.importCsv)
									}
								>
									<DownloadIcon size={16} aria-hidden /> Download CSV
								</button>
								<button
									type="button"
									className="cta"
									disabled={Boolean(
										busy || !capture.eligible.length || !settingsReady,
									)}
									onClick={() => {
										setView("destination");
										void connectCap();
									}}
								>
									Import to Cap <ArrowRightIcon size={16} aria-hidden />
								</button>
							</div>
							{capture.omittedRows > 0 && (
								<p className="migration-note">
									{capture.omittedRows.toLocaleString()}{" "}
									{capture.omittedRows === 1 ? "record was" : "records were"}{" "}
									skipped because of a missing link, invalid owner or duplicate.
									You can review {capture.omittedRows === 1 ? "it" : "them"} in
									the full report.
								</p>
							)}
						</section>
					) : view === "destination" && capture ? (
						<section
							className="card migration-panel"
							aria-label="Confirm your Cap destination"
						>
							{connection ? (
								<>
									<div className="migration-connection">
										<div>
											<strong>{connection.context.user.email}</strong>
											<p>{connection.origin}</p>
										</div>
										<CheckCircle2Icon
											className="migration-connected"
											size={22}
											aria-label="Cap connected"
										/>
									</div>
									<label className="field">
										<span>Cap organization</span>
										<select
											value={organizationId}
											disabled={Boolean(busy)}
											onChange={(event) => {
												setOrganizationId(event.target.value);
												setAccepted(false);
											}}
										>
											<option value="">Choose organization</option>
											{connection.context.organizations.map((org) => (
												<option key={org.id} value={org.id}>
													{org.name}
													{org.canImport ? "" : " · admin access required"}
												</option>
											))}
										</select>
									</label>
									{!connection.context.isPro && (
										<p className="migration-warning">
											Loom imports require Cap Pro.
										</p>
									)}
									{destination && !destination.canImport && (
										<p className="migration-warning">
											Choose an organization where you’re an admin or owner.
										</p>
									)}
									<label className="migration-consent">
										<input
											type="checkbox"
											checked={accepted}
											disabled={Boolean(busy)}
											onChange={(event) => setAccepted(event.target.checked)}
										/>
										<span>
											I understand that{" "}
											<strong>
												{capture.eligible.length.toLocaleString()} available
												videos
											</strong>{" "}
											from <strong>{capture.source.workspace}</strong> will be
											imported into{" "}
											<strong>
												{destination?.name ?? "the selected organization"}
											</strong>{" "}
											with{" "}
											<strong>
												{connection.context.defaultPublic
													? "public, anyone-with-the-link"
													: "private"}
											</strong>{" "}
											Cap visibility.
										</span>
									</label>
									<p className="migration-note">
										Original creators are kept. Missing Cap members may be
										added. Loom folders and access settings are not copied.
										Inaccessible videos will be reported as failed.
									</p>
									<div className="migration-actions">
										<button
											type="button"
											className="cta"
											disabled={Boolean(busy || !canImport)}
											onClick={() => void startImport()}
										>
											{busy === "import" ? "Starting import…" : "Start import"}{" "}
											<ArrowRightIcon size={16} aria-hidden />
										</button>
										<button
											type="button"
											className="migration-text-button"
											disabled={Boolean(busy)}
											onClick={() => void connectCap()}
										>
											Reconnect Cap
										</button>
									</div>
								</>
							) : (
								<div className="migration-connect-cap">
									<p>
										Use your Cap dashboard account to choose a destination.
										Nothing is imported until you confirm.
									</p>
									{!busy && (
										<button
											type="button"
											className="cta"
											disabled={!settingsReady}
											onClick={() => void connectCap()}
										>
											Connect Cap <ArrowRightIcon size={16} aria-hidden />
										</button>
									)}
								</div>
							)}
						</section>
					) : null}

					{status && !receipt && (
						<output className="migration-status" aria-live="polite">
							{busy && (
								<svg
									className="migration-progress"
									viewBox="0 0 180 20"
									aria-hidden="true"
								>
									<path
										className="migration-progress-track"
										d="M 6 10 q 6 -7 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0"
									/>
									<path
										className="migration-progress-ink"
										d="M 6 10 q 6 -7 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0"
									/>
								</svg>
							)}
							{status}
						</output>
					)}
					{error && (
						<p className="paper-pill error migration-error" role="alert">
							{error}
						</p>
					)}

					{capture && view !== "connect" && (
						<details className="migration-preview">
							<summary>
								Preview videos and full report{" "}
								<ChevronDownIcon size={15} aria-hidden />
							</summary>
							<div className="migration-preview-heading">
								<p>
									Every source record is kept here, including anything skipped.
								</p>
								<button
									type="button"
									className="cta ghost"
									onClick={() =>
										downloadCsv(
											"cap-loom-inventory-report.csv",
											capture.reportCsv,
										)
									}
								>
									Download full report
								</button>
							</div>
							<div className="migration-readonly-table">
								<InventoryTable
									rows={capture.rows}
									headers={capture.table.headers}
									selected={selected}
									outcomes={emptyOutcomes}
									disabled
									apiBaseUrl={settings.apiBaseUrl}
									onSelect={ignoreSelection}
								/>
							</div>
						</details>
					)}
					{!receipt && view !== "connect" && (
						<button
							type="button"
							className="migration-text-button migration-back"
							disabled={Boolean(busy)}
							onClick={() =>
								goBack(view === "destination" ? "ready" : "connect")
							}
						>
							<ArrowLeftIcon size={14} aria-hidden />{" "}
							{view === "destination" ? "Back" : "Back to Loom"}
						</button>
					)}
					{view === "connect" && (
						<p className="migration-reassurance">
							<ShieldCheckIcon size={14} aria-hidden /> Read-only. Nothing in
							your Loom workspace is changed.
						</p>
					)}
				</div>
			</main>
			<footer className="footnote migration-footer">
				Already have an export? <a href="import.html">Open the CSV file tool</a>
			</footer>
		</>
	);
}

mountPageNav("import");
const root = document.getElementById("root");
if (!root) throw new Error("Missing migration root.");
createRoot(root).render(<Migration />);
