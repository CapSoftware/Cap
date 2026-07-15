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
	type LoomCsvImportRowResult,
} from "@/actions/loom";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { UpgradeModal } from "@/components/UpgradeModal";
import {
	canManageOrganizationSettings,
	getEffectiveOrganizationRole,
} from "@/lib/permissions/roles";

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
const MAX_LOOM_CSV_IMPORT_ROWS = 500;
const LOOM_CSV_BATCH_SIZE = 10;
const LOOM_CSV_BATCH_DELAY_MS = 1500;
const LOOM_CSV_LIMIT_MESSAGE =
	"每次最多可通过 CSV 导入 500 个视频。如需提高限制，请联系支持团队。";
const LOOM_CSV_PERMISSION_MESSAGE =
	"只有组织管理员和所有者可以通过 CSV 导入 Loom 视频。";

function delay(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function chunkRows<T>(rows: T[], size: number) {
	const chunks: T[][] = [];
	for (let index = 0; index < rows.length; index += size) {
		chunks.push(rows.slice(index, index + size));
	}
	return chunks;
}

function buildCsvImportResult(
	results: LoomCsvImportRowResult[],
	error?: string,
): LoomCsvImportResult {
	const importedCount = results.filter((row) => row.success).length;
	const failedCount = results.length - importedCount;

	return {
		success: importedCount > 0,
		importedCount,
		failedCount,
		results,
		error: error ?? (importedCount > 0 ? undefined : "未导入任何 Loom 视频。"),
	};
}

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

	if (inQuotes) throw new Error("CSV 中存在未闭合的引号字段。");

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
		throw new Error("未找到 CSV 表头。");
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

	const currentMember = activeOrganization?.members.find(
		(member) => member.userId === user?.id,
	);
	const currentRole = getEffectiveOrganizationRole({
		userId: user?.id,
		ownerId: activeOrganization?.organization.ownerId,
		memberRole: currentMember?.role,
	});
	const canUseCsvImport = canManageOrganizationSettings(currentRole);

	const [mode, setMode] = useState<Mode>("single");
	const activeMode = canUseCsvImport ? mode : "single";
	const [upgradeModalOpen, setUpgradeModalOpen] = useState(!user?.isPro);

	const [loomUrl, setLoomUrl] = useState("");
	const [isImporting, setIsImporting] = useState(false);

	const inputRef = useRef<HTMLInputElement>(null);
	const [csvData, setCsvData] = useState<CsvData | null>(null);
	const [mapping, setMapping] = useState<Mapping>({});
	const [isDragOver, setIsDragOver] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [isCsvImporting, setIsCsvImporting] = useState(false);
	const [csvImportProgress, setCsvImportProgress] = useState(0);
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
	const csvLimitExceeded = readyRows.length > MAX_LOOM_CSV_IMPORT_ROWS;
	const canImport =
		canUseCsvImport &&
		!!activeOrganization &&
		!selectedColumnsConflict &&
		readyRows.length > 0 &&
		!csvLimitExceeded &&
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
				toast.error(importResult.error || "导入视频失败。");
				setIsImporting(false);
				return;
			}

			toast.success("Loom 视频已开始导入，稍后会显示在你的录制内容中。");
			router.push("/dashboard/caps");
		} catch {
			toast.error("发生意外错误，请重试。");
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

		if (!canUseCsvImport) {
			toast.error(LOOM_CSV_PERMISSION_MESSAGE);
			return;
		}

		if (!user.isPro) {
			setUpgradeModalOpen(true);
			return;
		}

		if (!file.name.toLowerCase().endsWith(".csv") && file.type !== "text/csv") {
			toast.error("请上传 CSV 文件。");
			return;
		}

		try {
			const parsed = parseCsv(await file.text(), file.name);
			if (parsed.rows.length > MAX_LOOM_CSV_IMPORT_ROWS) {
				toast.error(LOOM_CSV_LIMIT_MESSAGE);
			}

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
			setCsvImportProgress(0);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "无法解析 CSV。");
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
		if (csvLimitExceeded) {
			toast.error(LOOM_CSV_LIMIT_MESSAGE);
			return;
		}

		if (!activeOrganization || !canImport) return;

		setIsCsvImporting(true);
		setResult(null);
		setCsvImportProgress(0);

		try {
			const batches = chunkRows(readyRows, LOOM_CSV_BATCH_SIZE);
			let combinedResults: LoomCsvImportRowResult[] = [];
			let blockedError: string | undefined;

			for (const [batchIndex, batch] of batches.entries()) {
				const importResult = await importFromLoomCsv({
					orgId: activeOrganization.organization.id,
					rows: batch,
				});

				if (importResult.results.length === 0 && importResult.error) {
					blockedError = importResult.error;
					break;
				}

				combinedResults = [...combinedResults, ...importResult.results];
				setCsvImportProgress(combinedResults.length);
				setResult(buildCsvImportResult(combinedResults));

				if (batchIndex < batches.length - 1) {
					await delay(LOOM_CSV_BATCH_DELAY_MS);
				}
			}

			const finalResult = buildCsvImportResult(combinedResults, blockedError);
			setResult(finalResult);

			if (finalResult.importedCount > 0) {
				toast.success(`已开始导入 ${finalResult.importedCount} 个 Loom 视频。`);
				router.refresh();
			} else {
				toast.error(finalResult.error || "未导入任何 Loom 视频。");
			}

			setConfirmOpen(false);
		} catch {
			toast.error("发生意外错误，请重试。");
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
					返回导入
				</Link>
				<div className="flex gap-4 items-start">
					<div className="flex flex-shrink-0 justify-center items-center rounded-full size-12 bg-gray-3">
						<LoomMark size={20} />
					</div>
					<div>
						<h1 className="text-2xl font-medium text-gray-12">从 Loom 导入</h1>
						<p className="mt-1 max-w-xl text-sm text-gray-10">
							{canUseCsvImport
								? "将单个 Loom 视频导入 Cap，或通过 CSV 为组织成员和新用户批量导入录制内容。"
								: "粘贴 Loom 分享链接，将其导入 Cap。"}
						</p>
					</div>
				</div>
			</div>

			<div className="flex flex-col gap-6 w-full max-w-4xl">
				{canUseCsvImport && (
					<div
						role="tablist"
						aria-label="Loom 导入模式"
						className="flex gap-1 p-1 rounded-full border w-fit border-gray-3 bg-gray-2"
					>
						<ModeTab
							active={activeMode === "single"}
							icon={faLink}
							label="单个视频"
							onClick={() => setMode("single")}
						/>
						<ModeTab
							active={activeMode === "csv"}
							icon={faFileCsv}
							label="批量导入"
							onClick={() => setMode("csv")}
						/>
					</div>
				)}

				{activeMode === "single" ? (
					<div className="flex overflow-hidden flex-col rounded-xl border bg-gray-1 border-gray-3">
						<div className="flex flex-col gap-1 px-6 py-5 border-b border-gray-3">
							<p className="text-sm font-medium text-gray-12">Loom 视频网址</p>
							<p className="text-xs text-gray-10">
								粘贴任意 Loom 分享链接。视频将在后台下载并处理。
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
									取消
								</Button>
								<Button
									type="button"
									onClick={handleSingleImport}
									size="sm"
									spinner={isImporting}
									variant="dark"
									disabled={!isValidLoomUrl || isImporting}
								>
									{isImporting ? "正在导入……" : "导入 Loom"}
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
												首次使用？从模板开始
											</p>
											<p className="text-xs text-gray-10">
												必须包含两列：{" "}
												<code className="px-1.5 py-0.5 rounded bg-gray-3 text-gray-12 text-[11px] font-mono">
													loom_video_url
												</code>{" "}
												和{" "}
												<code className="px-1.5 py-0.5 rounded bg-gray-3 text-gray-12 text-[11px] font-mono">
													user_email
												</code>
												。添加{" "}
												<code className="px-1.5 py-0.5 rounded bg-gray-3 text-gray-12 text-[11px] font-mono">
													space_name
												</code>{" "}
												可将视频放入指定空间。尚不是成员的邮箱将直接添加，不发送邮件邀请。
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
										下载模板
									</Button>
								</div>

								<section
									aria-label="上传 CSV"
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
												将 CSV 拖放到此处
											</p>
											<p className="text-xs text-gray-10">
												或浏览电脑并上传文件。
											</p>
										</div>
										<Button
											type="button"
											onClick={() => inputRef.current?.click()}
											variant="dark"
											size="sm"
											className="mt-2"
										>
											浏览 CSV
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
												检测到 {csvData.rows.length} 行
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
											setCsvImportProgress(0);
										}}
									>
										替换 CSV
									</Button>
								</div>

								<div className="flex flex-col gap-6 p-6">
									<div>
										<p className="mb-3 text-xs font-medium tracking-wide uppercase text-gray-10">
											映射列
										</p>
										<div className="grid grid-cols-1 gap-4 md:grid-cols-3">
											<MappingField
												label="Loom 视频网址"
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
												label="用户邮箱"
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
												label="空间名称"
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
												请为每个映射字段选择不同的列。
											</p>
										)}
									</div>

									<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
										<StatBox
											tone="positive"
											label="可导入"
											value={readyRows.length}
										/>
										<StatBox tone="warn" label="需要修正" value={invalidRows} />
										<StatBox
											tone="neutral"
											label="映射总数"
											value={mappedRows.length}
										/>
									</div>

									{csvLimitExceeded && (
										<div className="flex gap-3 items-start p-4 rounded-lg border bg-red-2 border-red-4 text-red-11">
											<FontAwesomeIcon
												className="mt-0.5 size-4"
												icon={faTriangleExclamation}
											/>
											<div className="text-sm">
												<p className="font-medium">
													每次最多可通过 CSV 导入 {MAX_LOOM_CSV_IMPORT_ROWS}{" "}
													个视频。
												</p>
												<p className="mt-1 text-red-10">
													请将文件拆分为更小的批次，或{" "}
													<a className="underline" href="mailto:hello@cap.so">
														联系支持团队
													</a>{" "}
													以提高限制。
												</p>
											</div>
										</div>
									)}

									{previewRows.length > 0 && (
										<div className="overflow-hidden rounded-lg border border-gray-3">
											<Table>
												<TableHeader>
													<TableRow>
														<TableHead className="w-16">行</TableHead>
														<TableHead>Loom 网址</TableHead>
														<TableHead>用户邮箱</TableHead>
														<TableHead>空间</TableHead>
														<TableHead className="w-32">状态</TableHead>
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
													正在显示 {mappedRows.length} 个映射行中的{" "}
													{previewRows.length} 个。
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
												setCsvImportProgress(0);
											}}
										>
											清除
										</Button>
										<Button
											type="button"
											variant="dark"
											size="sm"
											disabled={!canImport}
											onClick={() => setConfirmOpen(true)}
										>
											检查导入内容
										</Button>
									</div>
								</div>
							</div>
						)}

						{result && (
							<div className="flex overflow-hidden flex-col rounded-xl border bg-gray-1 border-gray-3">
								<div className="flex flex-col gap-3 justify-between px-6 py-5 border-b sm:flex-row sm:items-center border-gray-3">
									<div>
										<p className="text-sm font-medium text-gray-12">导入结果</p>
										<p className="mt-1 text-xs text-gray-10">
											已开始 {result.importedCount} 个，失败{" "}
											{result.failedCount} 个
										</p>
									</div>
									<div className="flex gap-2 items-center">
										<StatusPill
											ready
											label={`${result.importedCount} 个已开始`}
										/>
										{result.failedCount > 0 && (
											<StatusPill
												ready={false}
												label={`${result.failedCount} 个失败`}
											/>
										)}
									</div>
								</div>
								<div className="overflow-hidden">
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead className="w-16">行</TableHead>
												<TableHead>用户邮箱</TableHead>
												<TableHead>空间</TableHead>
												<TableHead>状态</TableHead>
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
														{row.error || (row.success ? "已开始" : "失败")}
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
						<DialogTitle>开始 CSV 导入</DialogTitle>
					</DialogHeader>
					<div className="p-5 text-sm text-gray-11">
						将为现有成员或新增用户导入 {readyRows.length} 个视频，每批{" "}
						{LOOM_CSV_BATCH_SIZE} 个。
						{readyRows.some((row) => row.spaceName) && (
							<span className="block mt-2">
								包含空间名称的行将添加到相应空间；缺少的空间会自动创建。
							</span>
						)}
						{invalidRows > 0 && (
							<span className="block mt-2">
								将跳过 {invalidRows} 行，因为 Loom 网址、邮箱或空间名称无效。
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
							取消
						</Button>
						<Button
							type="button"
							onClick={handleCsvImport}
							size="sm"
							spinner={isCsvImporting}
							variant="dark"
							disabled={!canImport}
						>
							{isCsvImporting
								? `正在导入 ${csvImportProgress}/${readyRows.length}`
								: "开始导入"}
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
		? [{ value: OPTIONAL_COLUMN_VALUE, label: "不导入" }, ...options]
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
				placeholder="选择列"
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
		{label ?? (ready ? "可导入" : "需要修正")}
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
