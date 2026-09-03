import {
	ArrowRightIcon,
	CheckCircle2Icon,
	DownloadIcon,
	FileSpreadsheetIcon,
	FolderInputIcon,
	InfoIcon,
	LockKeyholeIcon,
	PauseIcon,
	RefreshCwIcon,
	ShieldCheckIcon,
	UploadIcon,
	XIcon,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { createRoot } from "react-dom/client";
import { mountPageNav } from "../shared/page-nav";
import { sendServiceWorkerMessage } from "../shared/runtime";
import {
	AUTH_KEY,
	defaultSettings,
	loadAuth,
	loadPendingAuth,
	loadSettings,
	SETTINGS_KEY,
} from "../shared/storage";
import type { ExtensionAuth, ExtensionSettings } from "../shared/types";
import { fetchImportContext, type ImportContext, importLoomRow } from "./api";
import {
	buildInventory,
	type ColumnMapping,
	detectColumns,
	exportImportCsv,
	exportInventoryCsv,
	type InventoryOptions,
	type InventoryRow,
	MAX_FILE_BYTES,
	parseInventory,
} from "./inventory";
import { canSubmitRow, InventoryTable } from "./inventory-table";
import { MappingPanel } from "./mapping-panel";
import {
	clearImportInventory,
	type ImportDraft,
	type ImportRun,
	loadImportInventory,
	saveImportDraft,
	saveImportRun,
} from "./persistence";
import { type ImportOutcome, runImportQueue } from "./queue";
import "../shared/paper.css";
import "./styles.css";

const EMPTY_OUTCOMES: Record<number, ImportOutcome> = {};
const EMPTY_SELECTION: number[] = [];
const messageOf = (error: unknown) =>
	error instanceof Error
		? error.message
		: "Something went wrong. Please try again.";

const downloadCsv = (filename: string, content: string) => {
	const url = URL.createObjectURL(
		new Blob([content], { type: "text/csv;charset=utf-8" }),
	);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

const ConfirmImport = ({
	rows,
	organization,
	accountEmail,
	defaultPublic,
	onClose,
	onConfirm,
}: {
	rows: InventoryRow[];
	organization: string;
	accountEmail: string;
	defaultPublic: boolean;
	onClose: () => void;
	onConfirm: () => void;
}) => {
	const dialog = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	const [reviewed, setReviewed] = useState(false);
	useEffect(() => {
		dialog.current?.showModal();
	}, []);
	return (
		<dialog
			ref={dialog}
			className="import-dialog"
			onCancel={onClose}
			aria-labelledby={titleId}
		>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (reviewed) onConfirm();
				}}
			>
				<div className="dialog-heading">
					<span className="dialog-icon">
						<FolderInputIcon size={23} aria-hidden />
					</span>
					<button
						className="icon-button"
						type="button"
						aria-label="Close confirmation"
						onClick={onClose}
					>
						<XIcon size={18} aria-hidden />
					</button>
				</div>
				<h2 id={titleId}>Ready to bring these over?</h2>
				<p>
					You’re starting {rows.length.toLocaleString()} video{" "}
					{rows.length === 1 ? "import" : "imports"} into{" "}
					<strong>{organization}</strong>.
				</p>
				<dl className="confirmation-summary">
					<div>
						<dt>Signed in as</dt>
						<dd>{accountEmail}</dd>
					</div>
					<div>
						<dt>Video owners</dt>
						<dd>
							{new Set(rows.map((row) => row.ownerEmail)).size}{" "}
							{new Set(rows.map((row) => row.ownerEmail)).size === 1
								? "owner"
								: "owners"}
						</dd>
					</div>
					<div>
						<dt>Cap visibility</dt>
						<dd>
							{defaultPublic ? "Public · anyone with the link" : "Private"}
						</dd>
					</div>
					<div>
						<dt>Loom access settings</dt>
						<dd>Not copied</dd>
					</div>
				</dl>
				<p className="dialog-note">
					Missing members may be added to this organization. Named Spaces may be
					created, and video owners added to them. Titles come from Loom;
					preview titles do not rename videos.
				</p>
				<p className="dialog-note">
					A valid link isn’t proof of download access. Private, unshared or
					password-protected videos may fail. We never change their Loom sharing
					settings.
				</p>
				<label className="confirmation-check">
					<input
						type="checkbox"
						required
						checked={reviewed}
						onChange={(event) => setReviewed(event.target.checked)}
					/>
					<span>
						I’ve reviewed the selected videos, owners, Spaces and visibility.
					</span>
				</label>
				<div className="dialog-actions">
					<button type="button" className="button secondary" onClick={onClose}>
						Go back
					</button>
					<button type="submit" className="button primary" disabled={!reviewed}>
						Start {rows.length.toLocaleString()}{" "}
						{rows.length === 1 ? "import" : "imports"}
						<ArrowRightIcon size={16} aria-hidden />
					</button>
				</div>
			</form>
		</dialog>
	);
};

function App() {
	const [draft, setDraft] = useState<ImportDraft | null>(null);
	const [run, setRun] = useState<ImportRun | null>(null);
	const [loaded, setLoaded] = useState(false);
	const [blockedTab, setBlockedTab] = useState(false);
	const [settings, setSettings] = useState<ExtensionSettings>(defaultSettings);
	const [auth, setAuth] = useState<ExtensionAuth | null>(null);
	const [context, setContext] = useState<ImportContext | null>(null);
	const [connecting, setConnecting] = useState(false);
	const [authPending, setAuthPending] = useState(false);
	const [connectionError, setConnectionError] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loadingFile, setLoadingFile] = useState(false);
	const [savingDraft, setSavingDraft] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [running, setRunning] = useState(false);
	const [pausing, setPausing] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);
	const stopRequested = useRef(false);
	const runningRef = useRef(false);
	const loadingFileRef = useRef(false);
	const pendingDraftSaves = useRef(0);
	const draftSaveFailed = useRef(false);
	const draftRevision = useRef(0);
	const connectionVersion = useRef(0);
	const runRef = useRef<ImportRun | null>(null);
	const table = draft?.table;
	const mapping = draft?.mapping;
	const options = draft?.options;
	const selection = draft?.selected ?? EMPTY_SELECTION;
	const rows = useMemo(
		() =>
			table && mapping && options
				? buildInventory(table, mapping, options)
				: [],
		[table, mapping, options],
	);
	const selected = useMemo(() => new Set(selection), [selection]);
	const outcomes =
		run?.draftId === draft?.id
			? (run?.outcomes ?? EMPTY_OUTCOMES)
			: EMPTY_OUTCOMES;
	const hasResults = Object.keys(outcomes).length > 0;
	const organizationId =
		draft?.organizationId || context?.activeOrganizationId || "";
	const organization = context?.organizations.find(
		(item) => item.id === organizationId,
	);
	const selectedRows = useMemo(
		() => rows.filter((row) => selected.has(row.sourceRecord) && !row.issue),
		[rows, selected],
	);
	const pendingRows = useMemo(
		() =>
			selectedRows.filter((row) => canSubmitRow(outcomes[row.sourceRecord])),
		[selectedRows, outcomes],
	);
	const summary = useMemo(() => {
		let ready = 0;
		let missing = 0;
		let duplicates = 0;
		let review = 0;
		const owners = new Set<string>();
		for (const row of rows) {
			if (!row.issue && !row.reviewRequired) ready += 1;
			if (row.issue === "missing-link") missing += 1;
			if (row.issue === "duplicate") duplicates += 1;
			if (row.reviewRequired && !row.issue) review += 1;
			if (row.ownerEmail) owners.add(row.ownerEmail);
		}
		return {
			ready,
			missing,
			duplicates,
			review,
			owners: owners.size,
			attention: rows.length - ready,
		};
	}, [rows]);
	const totals = useMemo(() => {
		const values = Object.values(outcomes);
		return {
			started: values.filter((value) => value.state === "started").length,
			existing: values.filter((value) => value.state === "existing").length,
			failed: values.filter((value) => value.state === "failed").length,
			uncertain: values.filter((value) => value.state === "uncertain").length,
			sending: values.some((value) => value.state === "sending"),
		};
	}, [outcomes]);
	const maxRows = context?.maxRows ?? 500;
	const runMatchesConnection =
		!hasResults ||
		(run?.apiBaseUrl === settings.apiBaseUrl &&
			run.userId === context?.user.id &&
			run.organizationId === organizationId);
	const canImport = Boolean(
		auth &&
			context?.isPro &&
			organization?.canImport &&
			runMatchesConnection &&
			pendingRows.length > 0 &&
			pendingRows.length <= maxRows &&
			!running &&
			!loadingFile &&
			!connecting &&
			loaded &&
			!blockedTab,
	);

	const refreshConnection = useCallback(async () => {
		const version = ++connectionVersion.current;
		setConnecting(true);
		setContext(null);
		setConnectionError(null);
		try {
			const [nextSettings, nextAuth, pending] = await Promise.all([
				loadSettings(),
				loadAuth(),
				loadPendingAuth(),
			]);
			if (version !== connectionVersion.current) return;
			setSettings(nextSettings);
			setAuth(nextAuth);
			setAuthPending(Boolean(pending && !nextAuth));
			if (nextAuth) {
				const nextContext = await fetchImportContext({
					settings: nextSettings,
					auth: nextAuth,
				});
				if (version !== connectionVersion.current) return;
				setContext(nextContext);
			}
		} catch (caught) {
			if (version === connectionVersion.current)
				setConnectionError(messageOf(caught));
		} finally {
			if (version === connectionVersion.current) setConnecting(false);
		}
	}, []);

	useEffect(() => {
		let canceled = false;
		let release = () => {};
		const lifetime = new Promise<void>((resolve) => {
			release = resolve;
		});
		void navigator.locks
			.request(
				"cap-loom-importer-inventory",
				{ ifAvailable: true },
				async (lock) => {
					if (!lock) {
						if (!canceled) {
							setBlockedTab(true);
							setLoaded(true);
						}
						return;
					}
					try {
						const saved = await loadImportInventory();
						if (canceled) return;
						setDraft(saved.draft);
						if (saved.run && saved.run.draftId === saved.draft?.id) {
							await saveImportRun(saved.run);
							runRef.current = saved.run;
							setRun(saved.run);
						}
					} catch (caught) {
						if (!canceled)
							setError(
								`Could not restore the local inventory: ${messageOf(caught)}`,
							);
					} finally {
						if (!canceled) setLoaded(true);
					}
					await lifetime;
				},
			)
			.catch((caught: unknown) => {
				if (!canceled) {
					setBlockedTab(true);
					setLoaded(true);
					setError(messageOf(caught));
				}
			});
		void refreshConnection();
		const storageChanged = (
			changes: Record<string, chrome.storage.StorageChange>,
			area: string,
		) => {
			if (area === "local" && (changes[AUTH_KEY] || changes[SETTINGS_KEY])) {
				stopRequested.current = true;
				setConfirming(false);
				void refreshConnection();
			}
		};
		chrome.storage.onChanged.addListener(storageChanged);
		return () => {
			canceled = true;
			stopRequested.current = true;
			release();
			chrome.storage.onChanged.removeListener(storageChanged);
			connectionVersion.current += 1;
		};
	}, [refreshConnection]);

	useEffect(() => {
		if (!authPending) return;
		let pending = false;
		const timer = window.setInterval(() => {
			if (pending) return;
			pending = true;
			void sendServiceWorkerMessage({
				target: "service-worker",
				type: "bootstrap",
			})
				.then((response) => {
					if (!response.ok) {
						setConnectionError(response.error);
						setAuthPending(false);
						return;
					}
					setAuthPending(Boolean(response.authPending && !response.auth));
					if (response.authError) setConnectionError(response.authError);
					if (response.auth) void refreshConnection();
				})
				.catch((caught: unknown) => {
					setConnectionError(messageOf(caught));
					setAuthPending(false);
				})
				.finally(() => {
					pending = false;
				});
		}, 1000);
		return () => window.clearInterval(timer);
	}, [authPending, refreshConnection]);

	useEffect(() => {
		const warn = (event: BeforeUnloadEvent) => {
			if (
				!runningRef.current &&
				pendingDraftSaves.current === 0 &&
				!draftSaveFailed.current
			)
				return;
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, []);

	const persistDraft = (nextDraft: ImportDraft) => {
		const revision = ++draftRevision.current;
		pendingDraftSaves.current += 1;
		setSavingDraft(true);
		setDraft(nextDraft);
		void saveImportDraft(nextDraft)
			.then(() => {
				if (revision === draftRevision.current) draftSaveFailed.current = false;
			})
			.catch((caught: unknown) => {
				if (revision !== draftRevision.current) return;
				draftSaveFailed.current = true;
				setError(`Could not save your review locally: ${messageOf(caught)}`);
			})
			.finally(() => {
				pendingDraftSaves.current -= 1;
				if (pendingDraftSaves.current === 0) setSavingDraft(false);
			});
	};

	const signIn = async () => {
		setConnectionError(null);
		setAuthPending(true);
		try {
			const response = await sendServiceWorkerMessage({
				target: "service-worker",
				type: "auth-start",
			});
			if (!response.ok) throw new Error(response.error);
			setAuthPending(Boolean(response.authPending));
			if (response.auth) await refreshConnection();
		} catch (caught) {
			setConnectionError(messageOf(caught));
			setAuthPending(false);
		}
	};

	const openFile = async (file?: File) => {
		if (
			!file ||
			loadingFileRef.current ||
			runningRef.current ||
			hasResults ||
			blockedTab
		)
			return;
		loadingFileRef.current = true;
		setLoadingFile(true);
		setError(null);
		try {
			if (file.size > MAX_FILE_BYTES)
				throw new Error("Choose a file smaller than 10 MB.");
			const nextTable = parseInventory(await file.text(), file.name);
			const nextMapping = detectColumns(nextTable.headers);
			const nextOptions: InventoryOptions = {
				ownerMode: nextMapping.owner >= 0 ? "column" : "override",
				ownerEmail: context?.user.email ?? "",
				spaceMode: nextMapping.space >= 0 ? "column" : "none",
				spaceName: "",
			};
			const nextRows = buildInventory(nextTable, nextMapping, nextOptions);
			const nextDraft: ImportDraft = {
				id: crypto.randomUUID(),
				fileName: file.name,
				table: nextTable,
				mapping: nextMapping,
				options: nextOptions,
				selected: nextRows
					.filter((row) => !row.issue && !row.reviewRequired)
					.map((row) => row.sourceRecord),
				organizationId,
			};
			await clearImportInventory();
			await saveImportDraft(nextDraft);
			draftRevision.current += 1;
			draftSaveFailed.current = false;
			setDraft(nextDraft);
			setRun(null);
			runRef.current = null;
			setConfirming(false);
		} catch (caught) {
			setError(messageOf(caught));
		} finally {
			loadingFileRef.current = false;
			setLoadingFile(false);
			if (fileInput.current) fileInput.current.value = "";
		}
	};

	const updateMapping = (
		nextMapping: ColumnMapping,
		nextOptions: InventoryOptions,
	) => {
		if (!draft || runningRef.current || loadingFileRef.current || hasResults)
			return;
		persistDraft({
			...draft,
			mapping: nextMapping,
			options: nextOptions,
		});
		setConfirming(false);
	};

	const changeSelection = (records: number[], value: boolean) => {
		if (!draft || runningRef.current || loadingFileRef.current) return;
		const next = new Set(draft.selected);
		for (const record of records) {
			if (value) next.add(record);
			else next.delete(record);
		}
		persistDraft({ ...draft, selected: Array.from(next) });
		setConfirming(false);
	};

	const clearInventory = async () => {
		if (runningRef.current || loadingFileRef.current) return;
		if (
			hasResults &&
			!window.confirm(
				"Clear the locally saved inventory and progress? Any imports already started will continue in Cap.",
			)
		)
			return;
		try {
			setDraft(null);
			await clearImportInventory();
			draftRevision.current += 1;
			draftSaveFailed.current = false;
			setRun(null);
			runRef.current = null;
			setError(null);
			setConfirming(false);
		} catch (caught) {
			setError(messageOf(caught));
		}
	};

	const exportSelected = () => {
		try {
			downloadCsv("cap-loom-import.csv", exportImportCsv(pendingRows));
			setError(null);
		} catch (caught) {
			setError(messageOf(caught));
		}
	};

	const exportReport = () => {
		if (!draft) return;
		try {
			const headers = [...draft.table.headers];
			const usedHeaders = new Set(
				headers.map((header) => header.trim().toLowerCase()),
			);
			for (const label of [
				"cap_import_status",
				"cap_video_url",
				"cap_import_message",
				"cap_import_selected",
			]) {
				let name = label;
				while (usedHeaders.has(name)) name = `_${name}`;
				usedHeaders.add(name);
				headers.push(name);
			}
			const reportRows = rows.map((row) => {
				const outcome = outcomes[row.sourceRecord];
				return {
					...row,
					raw: [
						...row.raw,
						outcome?.state ?? "not-submitted",
						outcome?.videoId
							? new URL(
									`/s/${encodeURIComponent(outcome.videoId)}`,
									run?.apiBaseUrl ?? settings.apiBaseUrl,
								).toString()
							: "",
						outcome?.message ?? "",
						String(!row.issue && selected.has(row.sourceRecord)),
					],
				};
			});
			downloadCsv(
				"cap-loom-inventory-report.csv",
				exportInventoryCsv(
					{ headers, records: reportRows.map((row) => row.raw) },
					reportRows,
				),
			);
			setError(null);
		} catch (caught) {
			setError(messageOf(caught));
		}
	};

	const startImport = async () => {
		if (
			!canImport ||
			!draft ||
			!auth ||
			!context ||
			runningRef.current ||
			loadingFileRef.current
		)
			return;
		const targetRows = [...pendingRows];
		const connection = { settings, auth };
		const targetOrg = organizationId;
		runningRef.current = true;
		stopRequested.current = false;
		setRunning(true);
		setConfirming(false);
		setError(null);
		try {
			await saveImportDraft({ ...draft, organizationId: targetOrg });
			draftSaveFailed.current = false;
			const nextRun: ImportRun =
				hasResults && runRef.current?.draftId === draft.id
					? runRef.current
					: {
							draftId: draft.id,
							userId: context.user.id,
							organizationId: targetOrg,
							apiBaseUrl: settings.apiBaseUrl,
							outcomes: {},
						};
			await saveImportRun(nextRun);
			runRef.current = nextRun;
			setRun(nextRun);
			setDraft({ ...draft, organizationId: targetOrg });
			await runImportQueue({
				rows: targetRows,
				shouldStop: () => stopRequested.current,
				submit: async (row) => {
					const [currentAuth, currentSettings] = await Promise.all([
						loadAuth(),
						loadSettings(),
					]);
					if (
						currentAuth?.authApiKey !== connection.auth.authApiKey ||
						currentSettings.apiBaseUrl !== connection.settings.apiBaseUrl
					)
						throw new Error(
							"Your Cap connection changed. Check the dashboard before continuing.",
						);
					return importLoomRow(connection, targetOrg, {
						rowNumber: row.sourceRecord,
						loomUrl: row.url,
						userEmail: row.ownerEmail,
						...(row.spaceName ? { spaceName: row.spaceName } : {}),
					});
				},
				onUpdate: async (outcome) => {
					const current = runRef.current;
					if (!current)
						throw new Error("The local import record is unavailable.");
					const updated = {
						...current,
						outcomes: { ...current.outcomes, [outcome.sourceRecord]: outcome },
					};
					await saveImportRun(updated);
					runRef.current = updated;
					setRun(updated);
				},
			});
		} catch (caught) {
			setError(
				`Import paused. ${messageOf(caught)} Any started imports continue in Cap.`,
			);
		} finally {
			runningRef.current = false;
			setRunning(false);
			setPausing(false);
		}
	};

	if (!loaded)
		return (
			<main className="import-loading">
				<RefreshCwIcon size={20} className="spin" aria-hidden />
				<p>Opening your importer…</p>
			</main>
		);
	if (blockedTab)
		return (
			<main className="import-loading">
				<LockKeyholeIcon size={28} aria-hidden />
				<h1>Your importer is already open</h1>
				<p>Use the other importer tab, or close it and reload this one.</p>
				{error ? <p role="alert">{error}</p> : null}
				<button
					className="button secondary"
					type="button"
					onClick={() => window.location.reload()}
				>
					Reload importer
				</button>
			</main>
		);

	return (
		<main className="import-layout">
			<header className="import-heading">
				<div>
					<p className="eyebrow">
						<span /> LOOM → CAP
					</p>
					<h1>
						Bring your videos <span>with you.</span>
					</h1>
					<p className="intro">
						Review every row of your Loom export, even when links are missing.
						<br />
						Choose what to bring into Cap, or download a prepared CSV.
					</p>
				</div>
				<div className="privacy-pill">
					<ShieldCheckIcon size={16} aria-hidden />
					Your review stays in this browser
				</div>
			</header>
			<input
				ref={fileInput}
				className="sr-only"
				type="file"
				accept=".csv,.tsv,.json,text/csv,text/tab-separated-values,application/json"
				aria-label="Choose inventory file"
				disabled={running || loadingFile || hasResults}
				onChange={(event) => void openFile(event.target.files?.[0])}
			/>
			{error ? (
				<div className="notice notice-error" role="alert">
					<InfoIcon size={18} aria-hidden />
					<span>{error}</span>
					<button
						type="button"
						className="icon-button"
						aria-label="Dismiss error"
						onClick={() => setError(null)}
					>
						<XIcon size={16} aria-hidden />
					</button>
				</div>
			) : null}
			{!draft ? (
				<>
					<section
						className={`drop-zone ${dragging ? "dragging" : ""}`}
						onDragOver={(event) => {
							event.preventDefault();
							setDragging(true);
						}}
						onDragLeave={() => setDragging(false)}
						onDrop={(event) => {
							event.preventDefault();
							setDragging(false);
							void openFile(event.dataTransfer.files[0]);
						}}
						aria-label="Upload your Loom inventory"
					>
						<div className="file-illustration">
							<span className="back-file" />
							<span className="front-file">
								<FileSpreadsheetIcon size={38} strokeWidth={1.3} aria-hidden />
							</span>
						</div>
						<h2>
							{loadingFile
								? "Reading your inventory…"
								: "Drop your export here"}
						</h2>
						<p>Loom exports, Cap import templates, or your own inventory.</p>
						<button
							className="button primary"
							type="button"
							disabled={loadingFile}
							onClick={() => fileInput.current?.click()}
						>
							<UploadIcon size={16} aria-hidden />
							Choose a file
						</button>
						<span className="file-formats">
							CSV, TSV or JSON · up to 10 MB · 50,000 records
						</span>
					</section>
					<div className="getting-started">
						<div>
							<span className="step-number">01</span>
							<h3>Export from Loom</h3>
							<p>
								Download your workspace’s Engagement Insights CSV from{" "}
								<a
									href="https://www.loom.com/settings/workspace#data"
									target="_blank"
									rel="noopener noreferrer"
								>
									Loom settings
								</a>
								.
							</p>
						</div>
						<div>
							<span className="step-number">02</span>
							<h3>Review your library</h3>
							<p>
								Review missing links, choose owners and Spaces, and select the
								videos you want to keep.
							</p>
						</div>
						<div>
							<span className="step-number">03</span>
							<h3>Import or take it with you</h3>
							<p>
								Start your imports in Cap, or download a prepared CSV and a
								complete inventory report.
							</p>
						</div>
					</div>
					<div className="quiet-note">
						<InfoIcon size={16} aria-hidden />
						<p>
							Loom can omit links for unshared videos, depending on your plan
							and access. We keep those records visible; we never invent missing
							links or change sharing settings.
						</p>
					</div>
				</>
			) : (
				<>
					<div className="file-strip">
						<FileSpreadsheetIcon size={21} aria-hidden />
						<div>
							<strong>{draft.fileName}</strong>
							<span>
								{rows.length.toLocaleString()} source records · saved locally
							</span>
							{savingDraft ? <output>Saving changes…</output> : null}
						</div>
						<div className="file-actions">
							{!hasResults ? (
								<button
									className="text-button"
									type="button"
									disabled={running || loadingFile}
									onClick={() => fileInput.current?.click()}
								>
									Change file
								</button>
							) : null}
							<button
								type="button"
								className="text-button"
								disabled={running || loadingFile}
								onClick={() => void clearInventory()}
							>
								Clear inventory
							</button>
						</div>
					</div>
					<section
						className="inventory-overview"
						aria-label="Inventory summary"
					>
						<div className="stat">
							<span>Total records</span>
							<strong>{rows.length.toLocaleString()}</strong>
							<small>Your full source inventory</small>
						</div>
						<div className="stat">
							<span>
								<i className="dot ready-dot" />
								Ready to review
							</span>
							<strong>{summary.ready.toLocaleString()}</strong>
							<small>Valid link and owner</small>
						</div>
						<div className="stat">
							<span>
								<i className="dot attention-dot" />
								Needs attention
							</span>
							<strong>{summary.attention.toLocaleString()}</strong>
							<small>
								{summary.missing.toLocaleString()} missing links ·{" "}
								{summary.duplicates.toLocaleString()} duplicates
							</small>
						</div>
						<div className="stat">
							<span>Cap owners</span>
							<strong>{summary.owners.toLocaleString()}</strong>
							<small>Based on your mapping below</small>
						</div>
						<div className="coverage-bar" aria-hidden="true">
							<span
								style={{
									width: `${rows.length ? (summary.ready / rows.length) * 100 : 0}%`,
								}}
							/>
						</div>
					</section>
					{summary.missing > 0 ? (
						<div className="notice notice-warning">
							<InfoIcon size={18} aria-hidden />
							<p>
								<strong>
									{summary.missing.toLocaleString()}{" "}
									{summary.missing === 1 ? "record has" : "records have"} no
									Loom link.
								</strong>{" "}
								These stay in your report but cannot be imported. A missing link
								does not mean a video is private. Ask the creator or Loom for a
								URL-bearing export.
							</p>
						</div>
					) : null}
					{summary.review > 0 ? (
						<div className="notice notice-neutral">
							<InfoIcon size={18} aria-hidden />
							<p>
								{summary.review.toLocaleString()}{" "}
								{summary.review === 1 ? "record needs" : "records need"}{" "}
								explicit review based on your file’s decision columns. These
								aren’t selected automatically.
							</p>
						</div>
					) : null}
					<MappingPanel
						headers={draft.table.headers}
						mapping={draft.mapping}
						options={draft.options}
						disabled={running || loadingFile || hasResults}
						onChange={updateMapping}
					/>
					<div className="selection-actions">
						<span>
							<strong>{selectedRows.length.toLocaleString()}</strong> selected
						</span>
						<button
							type="button"
							className="text-button"
							disabled={running || loadingFile}
							onClick={() =>
								changeSelection(
									rows
										.filter(
											(row) =>
												!row.issue &&
												!row.reviewRequired &&
												canSubmitRow(outcomes[row.sourceRecord]),
										)
										.map((row) => row.sourceRecord),
									true,
								)
							}
						>
							Select ready
						</button>
						<button
							type="button"
							className="text-button"
							disabled={running || loadingFile || !selected.size}
							onClick={() => changeSelection(Array.from(selected), false)}
						>
							Deselect all
						</button>
						<button
							type="button"
							className="text-button report-button"
							onClick={exportReport}
						>
							<DownloadIcon size={15} aria-hidden />
							Download full report
						</button>
					</div>
					<InventoryTable
						key={draft.id}
						rows={rows}
						headers={draft.table.headers}
						selected={selected}
						outcomes={outcomes}
						disabled={running || loadingFile}
						apiBaseUrl={run?.apiBaseUrl ?? settings.apiBaseUrl}
						onSelect={changeSelection}
					/>
					{hasResults ? (
						<section className="run-summary" aria-live="polite">
							<div className="run-heading">
								{running ? (
									<RefreshCwIcon className="spin" size={19} aria-hidden />
								) : (
									<CheckCircle2Icon size={20} aria-hidden />
								)}
								<h2>
									{running
										? pausing
											? "Pausing after the current request…"
											: "Starting your imports…"
										: "Your import progress"}
								</h2>
								{running ? (
									<button
										type="button"
										className="button secondary compact"
										disabled={pausing}
										onClick={() => {
											stopRequested.current = true;
											setPausing(true);
										}}
									>
										<PauseIcon size={14} aria-hidden />
										Pause
									</button>
								) : null}
							</div>
							<p>
								{totals.started} started · {totals.existing} already in Cap ·{" "}
								{totals.failed} not started · {totals.uncertain} unconfirmed
							</p>
							<p className="muted">
								“Started” means Cap accepted the import, not that processing or
								playback is complete.{" "}
								{running
									? "Keep this tab open until all requests are sent."
									: "Started imports continue processing in Cap."}
							</p>
							{totals.existing > 0 ? (
								<p className="muted">
									Videos already in Cap keep their existing owner and Spaces.
									They have not been imported again.
								</p>
							) : null}
							{totals.uncertain > 0 ? (
								<p className="uncertain-note">
									Unconfirmed rows are locked to prevent accidental repeats.
									Check them in your Cap dashboard; they are included in the
									full report.
								</p>
							) : null}
						</section>
					) : null}
					<section
						className="destination-panel"
						aria-label="Import destination"
					>
						<div>
							<h2>Import your selection</h2>
							<p>
								Download a prepared CSV, or send your selection straight to Cap.
							</p>
							{context ? <p>Signed in as {context.user.email}</p> : null}
						</div>
						<div className="destination-fields">
							{context ? (
								<label className="field">
									<span>Cap organization</span>
									<select
										aria-label="Cap organization"
										value={organizationId}
										disabled={running || loadingFile || hasResults}
										onChange={(event) => {
											persistDraft({
												...draft,
												organizationId: event.target.value,
											});
											setConfirming(false);
										}}
									>
										{!organization ? (
											<option value="">Choose an organization</option>
										) : null}
										{context.organizations.map((item) => (
											<option key={item.id} value={item.id}>
												{item.name}
												{item.canImport ? "" : " · admin access required"}
											</option>
										))}
									</select>
								</label>
							) : (
								<div className="connection-prompt">
									<LockKeyholeIcon size={18} aria-hidden />
									<span>
										{connecting
											? "Connecting to Cap…"
											: "Sign in to import into Cap. Preview and downloads are free to use."}
									</span>
								</div>
							)}
							<div className="destination-buttons">
								<button
									className="button secondary"
									type="button"
									disabled={!pendingRows.length || running || loadingFile}
									onClick={exportSelected}
								>
									<DownloadIcon size={16} aria-hidden />
									Download import CSV
								</button>
								{!auth ? (
									<button
										className="button primary"
										type="button"
										disabled={authPending || connecting}
										onClick={() => void signIn()}
									>
										{authPending ? "Signing in…" : "Sign in to Cap"}
										<ArrowRightIcon size={16} aria-hidden />
									</button>
								) : (
									<button
										className="button primary"
										type="button"
										disabled={!canImport}
										onClick={() => setConfirming(true)}
									>
										{running
											? "Importing…"
											: `Import ${pendingRows.length.toLocaleString()} ${pendingRows.length === 1 ? "video" : "videos"}`}
										<ArrowRightIcon size={16} aria-hidden />
									</button>
								)}
							</div>
						</div>
						{connectionError ? (
							<div className="connection-error" role="alert">
								<span>{connectionError}</span>
								<button
									className="text-button"
									type="button"
									disabled={connecting || running}
									onClick={() => void refreshConnection()}
								>
									Reconnect
								</button>
								{auth ? (
									<button
										className="text-button"
										type="button"
										disabled={authPending || running}
										onClick={() => void signIn()}
									>
										Sign in again
									</button>
								) : null}
							</div>
						) : null}
						{context && !context.isPro ? (
							<p className="eligibility-note">
								Loom imports require Cap Pro. You can still review and download
								your CSV.
							</p>
						) : null}
						{context && !organization?.canImport ? (
							<p className="eligibility-note">
								Choose an organization where you’re an admin or owner to import.
							</p>
						) : null}
						{!runMatchesConnection ? (
							<p className="eligibility-note">
								This run belongs to a different Cap connection. Reconnect to
								that account to continue, or clear the local inventory.
							</p>
						) : null}
						{pendingRows.length > maxRows ? (
							<p className="eligibility-note">
								Select up to {maxRows} videos per import run. You can export a
								CSV of the full selection.
							</p>
						) : null}
						<p className="destination-note">
							Only selected video links, owner emails and Space names are sent
							to Cap when you confirm. The full report keeps all records and
							neutralizes spreadsheet formulas; it is for review, not direct
							import.
							{hasResults
								? " Already submitted or unconfirmed rows are excluded from the import CSV."
								: ""}
						</p>
					</section>
				</>
			)}
			<footer className="import-footer">
				<LockKeyholeIcon size={13} aria-hidden />
				<span>
					Saved on this Chrome profile until cleared. No changes to your Loom
					workspace.
				</span>
				<a href="options.html">Extension settings</a>
			</footer>
			{confirming && organization && context ? (
				<ConfirmImport
					rows={pendingRows}
					organization={organization.name}
					accountEmail={context.user.email}
					defaultPublic={context.defaultPublic}
					onClose={() => setConfirming(false)}
					onConfirm={() => void startImport()}
				/>
			) : null}
		</main>
	);
}

mountPageNav("import");
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
