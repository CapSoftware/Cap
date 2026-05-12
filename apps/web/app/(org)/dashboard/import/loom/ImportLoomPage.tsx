"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Select,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@cap/ui";
import {
	faArrowLeft,
	faCircleCheck,
	faDownload,
	faFileCsv,
	faLink,
	faTriangleExclamation,
	faUpload,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { motion } from "framer-motion";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
	type ChangeEvent,
	type DragEvent,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	importFromLoom,
	importFromLoomCsv,
	type LoomCsvImportResult,
} from "@/actions/loom";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { UpgradeModal } from "@/components/UpgradeModal";

type Mode = "single" | "csv";

type CsvData = {
	fileName: string;
	headers: string[];
	rows: string[][];
};

type Mapping = {
	loomUrl?: string;
	userEmail?: string;
	spaceName?: string;
};

type MappedRow = {
	rowNumber: number;
	loomUrl: string;
	userEmail: string;
	spaceName: string;
};

const LOOM_CSV_TEMPLATE =
	"loom_video_url,user_email,space_name\nhttps://www.loom.com/share/0123456789abcdef,user@example.com,Sales\n";

const OPTIONAL_COLUMN_VALUE = "__cap_skip_column__";
const MAX_SPACE_NAME_LENGTH = 255;

function parseCsvRecords(text: string) {
	const records: string[][] = [];
	let field = "";
	let row: string[] = [];
	let inQuotes = false;
	const input = text.replace(/^\uFEFF/, "");

	for (let index = 0; index < input.length; index += 1) {
		const char = input.charAt(index);
		const next = input.charAt(index + 1);

		if (char === '"') {
			if (inQuotes && next === '"') {
				field += '"';
				index += 1;
			} else {
				inQuotes = !inQuotes;
			}
			continue;
		}

		if (char === "," && !inQuotes) {
			row.push(field.trim());
			field = "";
			continue;
		}

		if ((char === "\n" || char === "\r") && !inQuotes) {
			if (char === "\r" && next === "\n") index += 1;
			row.push(field.trim());
			if (row.some((cell) => cell.length > 0)) records.push(row);
			row = [];
			field = "";
			continue;
		}

		field += char;
	}

	if (inQuotes) throw new Error("CSV has an unclosed quoted field.");

	if (field.length > 0 || row.length > 0) {
		row.push(field.trim());
		if (row.some((cell) => cell.length > 0)) records.push(row);
	}

	return records;
}

function parseCsv(text: string, fileName: string): CsvData {
	const records = parseCsvRecords(text);
	const headers = records[0]?.map((header) => header.trim()) ?? [];
	const rows = records
		.slice(1)
		.filter((row) => row.some((cell) => cell.trim().length > 0));

	if (headers.length === 0) {
		throw new Error("No CSV headers found.");
	}

	return { fileName, headers, rows };
}

function normalizeHeader(value: string) {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function guessColumn(headers: string[], candidates: string[]) {
	const normalizedHeaders = headers.map(normalizeHeader);
	const directMatch = normalizedHeaders.findIndex((header) =>
		candidates.includes(header),
	);
	if (directMatch !== -1) return String(directMatch);

	const partialMatch = normalizedHeaders.findIndex((header) =>
		candidates.some((candidate) => header.includes(candidate)),
	);
	return partialMatch === -1 ? undefined : String(partialMatch);
}

function isLoomUrl(value: string) {
	try {
		return new URL(value).hostname.includes("loom.com");
	} catch {
		return false;
	}
}

function isEmail(value: string) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidSpaceName(value: string) {
	return value.length <= MAX_SPACE_NAME_LENGTH;
}

function pluralize(count: number, singular: string, plural: string) {
	return count === 1 ? singular : plural;
}

const LoomMark = ({ size = 18 }: { size?: number }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="none"
		role="img"
		aria-label="Loom"
	>
		<path
			fill="#625DF5"
			d="M15 7.222h-4.094l3.546-2.047-.779-1.35-3.545 2.048 2.046-3.546-1.349-.779L8.78 5.093V1H7.22v4.094L5.174 1.548l-1.348.779 2.046 3.545-3.545-2.046-.779 1.348 3.546 2.047H1v1.557h4.093l-3.545 2.047.779 1.35 3.545-2.047-2.047 3.545 1.35.779 2.046-3.546V15h1.557v-4.094l2.047 3.546 1.349-.779-2.047-3.546 3.545 2.047.779-1.349-3.545-2.046h4.093L15 7.222zm-7 2.896a2.126 2.126 0 110-4.252 2.126 2.126 0 010 4.252z"
		/>
	</svg>
);

export const ImportLoomPage = () => {
	const { user, activeOrganization } = useDashboardContext();
	const router = useRouter();

	const isOrganizationOwner =
		!!user && user.id === activeOrganization?.organization.ownerId;

	const [mode, setMode] = useState<Mode>("single");
	const [upgradeModalOpen, setUpgradeModalOpen] = useState(!user?.isPro);

	const [loomUrl, setLoomUrl] = useState("");
	const [isImporting, setIsImporting] = useState(false);

	const inputRef = useRef<HTMLInputElement>(null);
	const [csvData, setCsvData] = useState<CsvData | null>(null);
	const [mapping, setMapping] = useState<Mapping>({});
	const [isDragOver, setIsDragOver] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [isCsvImporting, setIsCsvImporting] = useState(false);
	const [result, setResult] = useState<LoomCsvImportResult | null>(null);

	const selectedColumnValues = [
		mapping.loomUrl,
		mapping.userEmail,
		mapping.spaceName,
	].filter((value) => value !== undefined);
	const selectedColumnsConflict =
		new Set(selectedColumnValues).size !== selectedColumnValues.length;

	const mappedRows = useMemo<MappedRow[]>(() => {
		if (
			!csvData ||
			mapping.loomUrl === undefined ||
			mapping.userEmail === undefined
		) {
			return [];
		}

		const loomIndex = Number(mapping.loomUrl);
		const emailIndex = Number(mapping.userEmail);
		const spaceIndex =
			mapping.spaceName === undefined ? undefined : Number(mapping.spaceName);

		return csvData.rows
			.map((row, index) => ({
				rowNumber: index + 2,
				loomUrl: (row[loomIndex] ?? "").trim(),
				userEmail: (row[emailIndex] ?? "").trim().toLowerCase(),
				spaceName:
					spaceIndex === undefined ? "" : (row[spaceIndex] ?? "").trim(),
			}))
			.filter((row) => row.loomUrl || row.userEmail || row.spaceName);
	}, [csvData, mapping.loomUrl, mapping.spaceName, mapping.userEmail]);

	const readyRows = useMemo(
		() =>
			mappedRows.filter(
				(row) =>
					isLoomUrl(row.loomUrl) &&
					isEmail(row.userEmail) &&
					isValidSpaceName(row.spaceName),
			),
		[mappedRows],
	);

	const invalidRows = mappedRows.length - readyRows.length;
	const previewRows = mappedRows.slice(0, 5);
	const canImport =
		!!activeOrganization &&
		!selectedColumnsConflict &&
		readyRows.length > 0 &&
		!isCsvImporting;

	const columnOptions =
		csvData?.headers.map((header, index) => ({
			value: String(index),
			label: header || `Column ${index + 1}`,
		})) ?? [];

	const isValidLoomUrl = (() => {
		try {
			const parsed = new URL(loomUrl.trim());
			return parsed.hostname.includes("loom.com");
		} catch {
			return false;
		}
	})();

	const handleSingleImport = async () => {
		if (!user || !activeOrganization) return;

		if (!user.isPro) {
			setUpgradeModalOpen(true);
			return;
		}

		if (!loomUrl.trim()) return;

		setIsImporting(true);

		try {
			const importResult = await importFromLoom({
				loomUrl: loomUrl.trim(),
				orgId: activeOrganization.organization.id,
			});

			if (!importResult.success) {
				toast.error(importResult.error || "Failed to import video.");
				setIsImporting(false);
				return;
			}

			toast.success(
				"Loom video import started! It will appear in your caps shortly.",
			);
			router.push("/dashboard/caps");
		} catch {
			toast.error("An unexpected error occurred. Please try again.");
		} finally {
			setIsImporting(false);
		}
	};

	const handleTemplateDownload = () => {
		const blob = new Blob([LOOM_CSV_TEMPLATE], {
			type: "text/csv;charset=utf-8",
		});
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = "cap-loom-import-template.csv";
		link.click();
		URL.revokeObjectURL(url);
	};

	const loadCsvFile = async (file: File) => {
		if (!user) return;

		if (!user.isPro) {
			setUpgradeModalOpen(true);
			return;
		}

		if (!file.name.toLowerCase().endsWith(".csv") && file.type !== "text/csv") {
			toast.error("Please upload a CSV file.");
			return;
		}

		try {
			const parsed = parseCsv(await file.text(), file.name);
			const loomUrlGuess = guessColumn(parsed.headers, [
				"loomvideourl",
				"loomurl",
				"loomlink",
				"videourl",
				"url",
			]);
			const userEmailGuess = guessColumn(parsed.headers, [
				"useremail",
				"memberemail",
				"owneremail",
				"email",
			]);
			const spaceNameGuess = guessColumn(parsed.headers, [
				"spacename",
				"space",
				"workspace",
				"workspacename",
			]);

			setCsvData(parsed);
			setMapping({
				loomUrl: loomUrlGuess,
				userEmail: userEmailGuess,
				spaceName: spaceNameGuess,
			});
			setResult(null);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not parse CSV.",
			);
		}
	};

	const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		if (!file) return;
		await loadCsvFile(file);
		if (inputRef.current) inputRef.current.value = "";
	};

	const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
		event.preventDefault();
		setIsDragOver(false);
		const file = event.dataTransfer.files[0];
		if (!file) return;
		await loadCsvFile(file);
	};

	const handleCsvImport = async () => {
		if (!activeOrganization || !canImport) return;

		setIsCsvImporting(true);

		try {
			const importResult = await importFromLoomCsv({
				orgId: activeOrganization.organization.id,
				rows: readyRows,
			});

			setResult(importResult);

			if (importResult.importedCount > 0) {
				toast.success(
					`${importResult.importedCount} ${pluralize(
						importResult.importedCount,
						"Loom import",
						"Loom imports",
					)} started.`,
				);
				router.refresh();
			} else {
				toast.error(importResult.error || "No Loom videos were imported.");
			}

			setConfirmOpen(false);
		} catch {
			toast.error("An unexpected error occurred. Please try again.");
		} finally {
			setIsCsvImporting(false);
		}
	};

	return (
		<div className="flex flex-col w-full h-full">
			<div className="mb-8">
				<Link
					href="/dashboard/import"
					className="inline-flex gap-2 items-center mb-4 text-sm transition-colors text-gray-10 hover:text-gray-12"
				>
					<FontAwesomeIcon className="size-3" icon={faArrowLeft} />
					Back to Import
				</Link>
				<div className="flex gap-4 items-start">
					<div className="flex flex-shrink-0 justify-center items-center rounded-full size-12 bg-gray-3">
						<LoomMark size={20} />
					</div>
					<div>
						<h1 className="text-2xl font-medium text-gray-12">
							Import from Loom
						</h1>
						<p className="mt-1 max-w-xl text-sm text-gray-10">
							{isOrganizationOwner
								? "Bring a single Loom video into Cap, or bulk import recordings for organization members from a CSV."
								: "Paste a Loom share link to bring it into Cap."}
						</p>
					</div>
				</div>
			</div>

			<div className="flex flex-col gap-6 w-full max-w-4xl">
				{isOrganizationOwner && (
					<div
						role="tablist"
						aria-label="Loom import mode"
						className="flex gap-1 p-1 rounded-full border w-fit border-gray-3 bg-gray-2"
					>
						<ModeTab
							active={mode === "single"}
							icon={faLink}
							label="Single Video"
							onClick={() => setMode("single")}
						/>
						<ModeTab
							active={mode === "csv"}
							icon={faFileCsv}
							label="Bulk Import"
							onClick={() => setMode("csv")}
						/>
					</div>
				)}

				{mode === "single" ? (
					<div className="flex overflow-hidden flex-col rounded-xl border bg-gray-1 border-gray-3">
						<div className="flex flex-col gap-1 px-6 py-5 border-b border-gray-3">
							<p className="text-sm font-medium text-gray-12">Loom video URL</p>
							<p className="text-xs text-gray-10">
								Paste any Loom share link. The video downloads and processes in
								the background.
							</p>
						</div>

						<div className="flex flex-col gap-4 p-6">
							<Input
								value={loomUrl}
								onChange={(event) => setLoomUrl(event.target.value)}
								placeholder="https://www.loom.com/share/..."
								onKeyDown={(event) => {
									if (event.key === "Enter" && isValidLoomUrl && !isImporting) {
										handleSingleImport();
									}
								}}
							/>

							<div className="flex flex-col-reverse gap-3 justify-end sm:flex-row">
								<Button
									type="button"
									size="sm"
									variant="gray"
									onClick={() => router.push("/dashboard/import")}
								>
									Cancel
								</Button>
								<Button
									type="button"
									onClick={handleSingleImport}
									size="sm"
									spinner={isImporting}
									variant="dark"
									disabled={!isValidLoomUrl || isImporting}
								>
									{isImporting ? "Importing..." : "Import Video"}
								</Button>
							</div>
						</div>
					</div>
				) : (
					<div className="flex flex-col gap-6">
						{!csvData && (
							<>
								<div className="flex flex-col gap-4 justify-between p-5 rounded-xl border sm:flex-row sm:items-center bg-gray-2 border-gray-3">
									<div className="flex gap-4 items-start sm:items-center">
										<div className="flex flex-shrink-0 justify-center items-center rounded-lg size-10 bg-gray-3 text-gray-11">
											<FontAwesomeIcon className="size-4" icon={faFileCsv} />
										</div>
										<div className="flex flex-col gap-1.5">
											<p className="text-sm font-medium text-gray-12">
												First time? Start with our template
											</p>
											<p className="text-xs text-gray-10">
												Two columns required:{" "}
												<code className="px-1.5 py-0.5 rounded bg-gray-3 text-gray-12 text-[11px] font-mono">
													loom_video_url
												</code>{" "}
												and{" "}
												<code className="px-1.5 py-0.5 rounded bg-gray-3 text-gray-12 text-[11px] font-mono">
													user_email
												</code>
												. Add{" "}
												<code className="px-1.5 py-0.5 rounded bg-gray-3 text-gray-12 text-[11px] font-mono">
													space_name
												</code>{" "}
												to place videos in spaces.
											</p>
										</div>
									</div>
									<Button
										type="button"
										variant="white"
										size="sm"
										onClick={handleTemplateDownload}
										className="flex-shrink-0"
									>
										<FontAwesomeIcon className="size-3.5" icon={faDownload} />
										Download Template
									</Button>
								</div>

								<section
									aria-label="CSV upload"
									onDragOver={(event) => {
										event.preventDefault();
										setIsDragOver(true);
									}}
									onDragLeave={() => setIsDragOver(false)}
									onDrop={handleDrop}
									className={clsx(
										"relative flex flex-col items-center justify-center w-full rounded-xl border-2 border-dashed transition-all duration-200 py-14 px-8",
										isDragOver
											? "border-blue-10 bg-blue-3"
											: "border-gray-4 bg-gray-1 hover:border-gray-6 hover:bg-gray-2",
									)}
								>
									<div className="flex flex-col gap-4 items-center">
										<div className="flex justify-center items-center rounded-full size-16 bg-gray-3 text-gray-10">
											<FontAwesomeIcon className="size-6" icon={faUpload} />
										</div>
										<div className="flex flex-col gap-1 items-center text-center">
											<p className="text-sm font-medium text-gray-12">
												Drag and drop your CSV here
											</p>
											<p className="text-xs text-gray-10">
												Or browse your computer to upload a file.
											</p>
										</div>
										<Button
											type="button"
											onClick={() => inputRef.current?.click()}
											variant="dark"
											size="sm"
											className="mt-2"
										>
											Browse CSV
										</Button>
									</div>
								</section>
							</>
						)}

						<input
							ref={inputRef}
							type="file"
							accept=".csv,text/csv"
							onChange={handleFileChange}
							className="hidden"
						/>

						{csvData && (
							<div className="flex overflow-hidden flex-col rounded-xl border bg-gray-1 border-gray-3">
								<div className="flex flex-col gap-3 justify-between px-6 py-5 border-b sm:flex-row sm:items-center border-gray-3">
									<div className="flex gap-3 items-center">
										<div className="flex justify-center items-center rounded-lg size-10 bg-gray-3 text-gray-11">
											<FontAwesomeIcon className="size-4" icon={faFileCsv} />
										</div>
										<div>
											<p className="text-sm font-medium text-gray-12">
												{csvData.fileName}
											</p>
											<p className="text-xs text-gray-10">
												{csvData.rows.length}{" "}
												{pluralize(csvData.rows.length, "row", "rows")} detected
											</p>
										</div>
									</div>
									<Button
										type="button"
										variant="gray"
										size="sm"
										onClick={() => {
											setCsvData(null);
											setMapping({});
											setResult(null);
										}}
									>
										Replace CSV
									</Button>
								</div>

								<div className="flex flex-col gap-6 p-6">
									<div>
										<p className="mb-3 text-xs font-medium tracking-wide uppercase text-gray-10">
											Map columns
										</p>
										<div className="grid grid-cols-1 gap-4 md:grid-cols-3">
											<MappingField
												label="Loom video URL"
												value={mapping.loomUrl}
												options={columnOptions}
												onValueChange={(value) =>
													setMapping((current) => ({
														...current,
														loomUrl: value,
													}))
												}
											/>
											<MappingField
												label="User email"
												value={mapping.userEmail}
												options={columnOptions}
												onValueChange={(value) =>
													setMapping((current) => ({
														...current,
														userEmail: value,
													}))
												}
											/>
											<MappingField
												label="Space name"
												value={mapping.spaceName}
												options={columnOptions}
												optional
												onValueChange={(value) =>
													setMapping((current) => ({
														...current,
														spaceName: value,
													}))
												}
											/>
										</div>
										{selectedColumnsConflict && (
											<p className="mt-3 text-sm text-red-10">
												Choose different columns for each mapped field.
											</p>
										)}
									</div>

									<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
										<StatBox
											tone="positive"
											label="Ready to import"
											value={readyRows.length}
										/>
										<StatBox
											tone="warn"
											label="Needs fix"
											value={invalidRows}
										/>
										<StatBox
											tone="neutral"
											label="Total mapped"
											value={mappedRows.length}
										/>
									</div>

									{previewRows.length > 0 && (
										<div className="overflow-hidden rounded-lg border border-gray-3">
											<Table>
												<TableHeader>
													<TableRow>
														<TableHead className="w-16">Row</TableHead>
														<TableHead>Loom URL</TableHead>
														<TableHead>User email</TableHead>
														<TableHead>Space</TableHead>
														<TableHead className="w-32">Status</TableHead>
													</TableRow>
												</TableHeader>
												<TableBody>
													{previewRows.map((row) => {
														const valid =
															isLoomUrl(row.loomUrl) &&
															isEmail(row.userEmail) &&
															isValidSpaceName(row.spaceName);
														return (
															<TableRow key={row.rowNumber}>
																<TableCell className="text-gray-10">
																	{row.rowNumber}
																</TableCell>
																<TableCell className="max-w-[260px] truncate">
																	{row.loomUrl || "—"}
																</TableCell>
																<TableCell>{row.userEmail || "—"}</TableCell>
																<TableCell>{row.spaceName || "—"}</TableCell>
																<TableCell>
																	<StatusPill ready={valid} />
																</TableCell>
															</TableRow>
														);
													})}
												</TableBody>
											</Table>
											{mappedRows.length > previewRows.length && (
												<div className="px-4 py-2 text-xs border-t bg-gray-2 text-gray-10 border-gray-3">
													Showing {previewRows.length} of {mappedRows.length}{" "}
													mapped rows.
												</div>
											)}
										</div>
									)}

									<div className="flex flex-col-reverse gap-3 justify-end sm:flex-row">
										<Button
											type="button"
											variant="gray"
											size="sm"
											onClick={() => {
												setCsvData(null);
												setMapping({});
												setResult(null);
											}}
										>
											Clear
										</Button>
										<Button
											type="button"
											variant="dark"
											size="sm"
											disabled={!canImport}
											onClick={() => setConfirmOpen(true)}
										>
											Review Import
										</Button>
									</div>
								</div>
							</div>
						)}

						{result && (
							<div className="flex overflow-hidden flex-col rounded-xl border bg-gray-1 border-gray-3">
								<div className="flex flex-col gap-3 justify-between px-6 py-5 border-b sm:flex-row sm:items-center border-gray-3">
									<div>
										<p className="text-sm font-medium text-gray-12">
											Import results
										</p>
										<p className="mt-1 text-xs text-gray-10">
											{result.importedCount}{" "}
											{pluralize(result.importedCount, "started", "started")},{" "}
											{result.failedCount}{" "}
											{pluralize(result.failedCount, "failed", "failed")}
										</p>
									</div>
									<div className="flex gap-2 items-center">
										<StatusPill
											ready
											label={`${result.importedCount} started`}
										/>
										{result.failedCount > 0 && (
											<StatusPill
												ready={false}
												label={`${result.failedCount} failed`}
											/>
										)}
									</div>
								</div>
								<div className="overflow-hidden">
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead className="w-16">Row</TableHead>
												<TableHead>User email</TableHead>
												<TableHead>Space</TableHead>
												<TableHead>Status</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{result.results.map((row) => (
												<TableRow key={`${row.rowNumber}-${row.userEmail}`}>
													<TableCell className="text-gray-10">
														{row.rowNumber}
													</TableCell>
													<TableCell>{row.userEmail || "—"}</TableCell>
													<TableCell>{row.spaceName || "—"}</TableCell>
													<TableCell
														className={
															row.success && !row.error
																? "text-green-10"
																: "text-red-10"
														}
													>
														{row.error || (row.success ? "Started" : "Failed")}
													</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								</div>
							</div>
						)}
					</div>
				)}
			</div>

			<Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
				<DialogContent className="w-[calc(100%-20px)] max-w-md">
					<DialogHeader
						icon={<FontAwesomeIcon icon={faFileCsv} className="size-3.5" />}
					>
						<DialogTitle>Start CSV import</DialogTitle>
					</DialogHeader>
					<div className="p-5 text-sm text-gray-11">
						{readyRows.length} {pluralize(readyRows.length, "video", "videos")}{" "}
						will be imported for organization members.
						{readyRows.some((row) => row.spaceName) && (
							<span className="block mt-2">
								Rows with a space name will be added to that space. Missing
								spaces will be created.
							</span>
						)}
						{invalidRows > 0 && (
							<span className="block mt-2">
								{invalidRows} {pluralize(invalidRows, "row", "rows")} will be
								skipped because the Loom URL, email, or space name is invalid.
							</span>
						)}
					</div>
					<DialogFooter>
						<Button
							type="button"
							size="sm"
							variant="gray"
							onClick={() => setConfirmOpen(false)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							onClick={handleCsvImport}
							size="sm"
							spinner={isCsvImporting}
							variant="dark"
							disabled={!canImport}
						>
							{isCsvImporting ? "Importing..." : "Start Import"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<UpgradeModal
				open={upgradeModalOpen}
				onOpenChange={setUpgradeModalOpen}
			/>
		</div>
	);
};

const ModeTab = ({
	active,
	icon,
	label,
	onClick,
}: {
	active: boolean;
	icon: typeof faLink;
	label: string;
	onClick: () => void;
}) => (
	<button
		type="button"
		role="tab"
		aria-selected={active}
		onClick={onClick}
		className={clsx(
			"relative flex items-center gap-2 px-4 h-9 rounded-full text-sm font-medium transition-colors",
			active
				? "text-gray-12"
				: "text-gray-10 hover:text-gray-12 cursor-pointer",
		)}
	>
		{active && (
			<motion.span
				layoutId="loom-mode-indicator"
				className="absolute inset-0 rounded-full border shadow-sm bg-gray-1 border-gray-4"
				transition={{ type: "spring", stiffness: 500, damping: 35 }}
			/>
		)}
		<FontAwesomeIcon icon={icon} className="relative size-3.5" />
		<span className="relative">{label}</span>
	</button>
);

const MappingField = ({
	label,
	value,
	options,
	optional = false,
	onValueChange,
}: {
	label: string;
	value: string | undefined;
	options: { value: string; label: string }[];
	optional?: boolean;
	onValueChange: (value: string | undefined) => void;
}) => {
	const fieldOptions = optional
		? [{ value: OPTIONAL_COLUMN_VALUE, label: "Do not import" }, ...options]
		: options;

	return (
		<div className="flex flex-col gap-2">
			<p className="text-xs font-medium text-gray-11">{label}</p>
			<Select
				value={value}
				onValueChange={(nextValue) =>
					onValueChange(
						nextValue === OPTIONAL_COLUMN_VALUE ? undefined : nextValue,
					)
				}
				options={fieldOptions}
				placeholder="Choose column"
			/>
		</div>
	);
};

const StatusPill = ({ ready, label }: { ready: boolean; label?: string }) => (
	<span
		className={clsx(
			"inline-flex items-center gap-1.5 px-2 h-6 rounded-full text-xs font-medium",
			ready ? "bg-green-3 text-green-11" : "bg-red-3 text-red-11",
		)}
	>
		<FontAwesomeIcon
			icon={ready ? faCircleCheck : faTriangleExclamation}
			className="size-3"
		/>
		{label ?? (ready ? "Ready" : "Needs fix")}
	</span>
);

const StatBox = ({
	label,
	value,
	tone,
}: {
	label: string;
	value: number;
	tone: "positive" | "warn" | "neutral";
}) => {
	const accent =
		tone === "positive"
			? "text-green-11"
			: tone === "warn" && value > 0
				? "text-red-11"
				: "text-gray-12";

	return (
		<div className="flex flex-col gap-1 p-4 rounded-lg border bg-gray-2 border-gray-3">
			<p className="text-xs text-gray-10">{label}</p>
			<p className={clsx("text-xl font-medium", accent)}>{value}</p>
		</div>
	);
};
