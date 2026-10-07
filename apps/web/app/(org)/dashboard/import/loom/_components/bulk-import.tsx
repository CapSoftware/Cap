"use client";

import { Button, Select } from "@cap/ui";
import type { Organisation } from "@cap/web-domain";
import clsx from "clsx";
import { useRouter } from "next/navigation";
import {
	type ChangeEvent,
	type DragEvent,
	useId,
	useMemo,
	useRef,
	useState,
	useTransition,
} from "react";
import { toast } from "sonner";
import { createLoomImportJobAction } from "@/actions/loom-import";
import {
	buildLoomImportPlan,
	type CsvTable,
	countFilledRows,
	detectLoomImportMapping,
	LOOM_CSV_TEMPLATE,
	LOOM_IMPORT_ISSUE_LABELS,
	LOOM_IMPORT_MAX_ROWS,
	type LoomImportField,
	type LoomImportMapping,
	parseCsv,
	tableFromPastedLinks,
} from "@/lib/loom-import/csv";
import { Doodle, InkArrow, StepMark } from "./doodles";
import { HowImportWorks } from "./how-import-works";
import "./loom-import.css";

const NOT_IN_FILE = "__not_in_file__";
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const numberFormat = new Intl.NumberFormat("en-US");
const plural = (count: number, one: string, many: string) =>
	`${numberFormat.format(count)} ${count === 1 ? one : many}`;

type Source = {
	name: string;
	table: CsvTable;
	pasted: boolean;
};

const GUIDE = [
	{
		doodle: "sheet" as const,
		title: "Get your list from Loom",
		body: "Admins can export every video from Settings, Workspace, Data, Export. Or just copy your Loom links.",
	},
	{
		doodle: "check" as const,
		title: "Drop it here",
		body: "We find the Loom links, owners and spaces on our own, and check every video before anything starts.",
	},
	{
		doodle: "move" as const,
		title: "Follow along live",
		body: "Videos keep their titles and recording dates. Close the tab any time, the import keeps going.",
	},
];

export const ImportGuide = ({ onHowItWorks }: { onHowItWorks: () => void }) => (
	<section aria-label="How importing from Loom works" className="li-scope">
		<ol className="grid grid-cols-1 gap-3 sm:grid-cols-3">
			{GUIDE.map((step, index) => (
				<li
					key={step.title}
					className="li-rise flex flex-col gap-3 rounded-xl border border-gray-3 bg-gray-1 p-4"
					style={{ animationDelay: `${index * 0.08}s` }}
				>
					<div className="flex h-[76px] items-center justify-center rounded-lg bg-gray-2">
						<Doodle kind={step.doodle} className="w-[92px]" />
					</div>
					<div className="flex items-start gap-2.5">
						<StepMark value={index + 1} />
						<div className="flex flex-col gap-1">
							<p className="text-sm font-medium text-gray-12">{step.title}</p>
							<p className="text-xs leading-relaxed text-gray-10">
								{step.body}
							</p>
						</div>
					</div>
				</li>
			))}
		</ol>
		<button
			type="button"
			onClick={onHowItWorks}
			className="mt-3 inline-flex items-center gap-1.5 text-sm text-gray-11 underline decoration-gray-6 underline-offset-4 transition-colors hover:text-gray-12 hover:decoration-gray-9"
		>
			How does importing work?
		</button>
	</section>
);

function downloadTemplate() {
	const blob = new Blob([LOOM_CSV_TEMPLATE], {
		type: "text/csv;charset=utf-8",
	});
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = "cap-loom-import-template.csv";
	link.click();
	URL.revokeObjectURL(url);
}

const SourcePicker = ({ onSource }: { onSource: (source: Source) => void }) => {
	const inputRef = useRef<HTMLInputElement>(null);
	const [isOver, setIsOver] = useState(false);
	const [pasteOpen, setPasteOpen] = useState(false);
	const [pasteText, setPasteText] = useState("");
	const pasteId = useId();

	const readFile = async (file: File) => {
		if (file.size > MAX_FILE_BYTES) {
			toast.error("That file is over 8 MB. Split it into smaller CSVs.");
			return;
		}
		try {
			const table = parseCsv(await file.text());
			if (countFilledRows(table) === 0) {
				toast.error("That CSV has a header but no rows.");
				return;
			}
			onSource({ name: file.name, table, pasted: false });
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "We couldn't read that CSV.",
			);
		}
	};

	const onDrop = (event: DragEvent<HTMLElement>) => {
		event.preventDefault();
		setIsOver(false);
		const file = event.dataTransfer.files[0];
		if (file) void readFile(file);
	};

	const onFile = (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		if (file) void readFile(file);
		event.target.value = "";
	};

	const usePasted = () => {
		const table = tableFromPastedLinks(pasteText);
		if (table.rows.length === 0) {
			toast.error("We couldn't find any Loom links in that text.");
			return;
		}
		onSource({ name: "Pasted Loom links", table, pasted: true });
	};

	return (
		<div className="li-scope flex flex-col gap-3">
			<section
				aria-label="Upload your Loom CSV"
				onDragOver={(event) => {
					event.preventDefault();
					setIsOver(true);
				}}
				onDragLeave={() => setIsOver(false)}
				onDrop={onDrop}
				className={clsx(
					"li-dropzone relative flex flex-col items-center gap-4 rounded-2xl px-6 py-10 text-center transition-colors duration-200 sm:flex-row sm:gap-8 sm:px-10 sm:text-left",
					isOver ? "is-over bg-blue-2" : "bg-gray-1",
				)}
			>
				<Doodle kind="drop" className="w-[120px] shrink-0" />
				<div className="flex flex-1 flex-col gap-1.5">
					<p className="text-base font-medium text-gray-12">
						{isOver ? "Drop to read your CSV" : "Drop your Loom CSV here"}
					</p>
					<p className="text-sm text-gray-10">
						Any CSV with Loom links works, including Loom's own export. Up to{" "}
						{numberFormat.format(LOOM_IMPORT_MAX_ROWS)} videos per file.
					</p>
					<div className="mt-3 flex flex-wrap items-center justify-center gap-2 sm:justify-start">
						<Button
							type="button"
							variant="dark"
							size="sm"
							onClick={() => inputRef.current?.click()}
						>
							Choose a CSV
						</Button>
						<Button
							type="button"
							variant="gray"
							size="sm"
							aria-expanded={pasteOpen}
							onClick={() => setPasteOpen((open) => !open)}
						>
							Paste links instead
						</Button>
					</div>
				</div>
				<input
					ref={inputRef}
					type="file"
					accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values"
					onChange={onFile}
					className="hidden"
					data-testid="loom-csv-input"
				/>
			</section>

			{pasteOpen && (
				<div className="li-rise flex flex-col gap-3 rounded-xl border border-gray-3 bg-gray-1 p-4">
					<label htmlFor={pasteId} className="text-sm font-medium text-gray-12">
						Paste Loom links
					</label>
					<textarea
						id={pasteId}
						value={pasteText}
						onChange={(event) => setPasteText(event.target.value)}
						rows={5}
						placeholder={
							"https://www.loom.com/share/…\nhttps://www.loom.com/share/…"
						}
						className="w-full resize-y rounded-lg border border-gray-4 bg-gray-2 px-3 py-2 font-mono text-[13px] text-gray-12 outline-none transition-colors placeholder:text-gray-8 focus:border-blue-8"
					/>
					<div className="flex items-center justify-between gap-3">
						<p className="text-xs text-gray-10">
							One per line, or paste a whole doc. We pick out the Loom links.
						</p>
						<Button
							type="button"
							size="sm"
							variant="dark"
							disabled={!pasteText.trim()}
							onClick={usePasted}
						>
							Use these links
						</Button>
					</div>
				</div>
			)}

			<div className="flex flex-col gap-2 rounded-xl bg-gray-2 px-4 py-3 text-xs text-gray-10 sm:flex-row sm:items-center sm:justify-between">
				<p>
					Got more than {numberFormat.format(LOOM_IMPORT_MAX_ROWS)} videos?
					Split them into a few CSVs and import each one. They can run side by
					side.
				</p>
				<button
					type="button"
					onClick={downloadTemplate}
					className="shrink-0 text-left text-gray-11 underline decoration-gray-6 underline-offset-4 hover:text-gray-12"
				>
					Download a template
				</button>
			</div>
		</div>
	);
};

const FIELD_COPY: Record<
	LoomImportField,
	{ label: string; found: string; missing: string }
> = {
	loomUrl: {
		label: "Loom links",
		found: "Each row becomes one video.",
		missing: "Pick the column that holds the Loom links.",
	},
	ownerEmail: {
		label: "Owners",
		found:
			"Each video goes to this person's library. New emails join your organization without an invite email.",
		missing: "Without owners, every video goes to your library.",
	},
	spaceName: {
		label: "Spaces",
		found: "Videos are added to these spaces. Missing spaces are created.",
		missing: "Optional. Leave it out to keep videos in each owner's library.",
	},
};

const MappingRow = ({
	field,
	table,
	value,
	onChange,
	optional,
}: {
	field: LoomImportField;
	table: CsvTable;
	value: number | undefined;
	onChange: (value: number | undefined) => void;
	optional: boolean;
}) => {
	const copy = FIELD_COPY[field];
	const example =
		value === undefined
			? null
			: (table.rows.find((row) => row[value]?.trim())?.[value] ?? null);
	const options = [
		...(optional ? [{ value: NOT_IN_FILE, label: "Not in this file" }] : []),
		...table.headers.map((header, index) => ({
			value: String(index),
			label: header || `Column ${index + 1}`,
		})),
	];

	return (
		<div className="grid grid-cols-1 items-center gap-2 py-3 sm:grid-cols-[120px_minmax(0,220px)_minmax(0,1fr)] sm:gap-4">
			<p className="text-sm font-medium text-gray-12">{copy.label}</p>
			<Select
				value={
					value === undefined
						? optional
							? NOT_IN_FILE
							: undefined
						: String(value)
				}
				onValueChange={(next) =>
					onChange(next === NOT_IN_FILE ? undefined : Number(next))
				}
				options={options}
				placeholder="Choose a column"
			/>
			<div className="flex min-w-0 items-center gap-2">
				{example ? (
					<>
						<InkArrow className="hidden shrink-0 sm:block" />
						<span className="min-w-0 truncate font-mono text-xs text-gray-11">
							{example}
						</span>
					</>
				) : (
					<span className="text-xs text-gray-10">{copy.missing}</span>
				)}
			</div>
		</div>
	);
};

const Stat = ({
	value,
	label,
	warn = false,
}: {
	value: number;
	label: string;
	warn?: boolean;
}) => (
	<div className="flex flex-col gap-0.5 rounded-xl border border-gray-3 bg-gray-2 px-4 py-3">
		<span
			className={clsx(
				"text-xl font-medium tabular-nums",
				warn && value > 0
					? "text-[#b4690e] dark:text-[#f3c675]"
					: "text-gray-12",
			)}
		>
			{numberFormat.format(value)}
		</span>
		<span className="text-xs text-gray-10">{label}</span>
	</div>
);

const ReviewCard = ({
	source,
	isAdmin,
	isPro,
	orgId,
	onReset,
}: {
	source: Source;
	isAdmin: boolean;
	isPro: boolean;
	orgId: Organisation.OrganisationId;
	onReset: () => void;
}) => {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();
	const [showIssues, setShowIssues] = useState(false);
	const [mapping, setMapping] = useState<LoomImportMapping>(() =>
		detectLoomImportMapping(source.table),
	);
	const plan = useMemo(
		() => buildLoomImportPlan(source.table, mapping, { allowOwners: isAdmin }),
		[source.table, mapping, isAdmin],
	);
	const problems = plan.issues.filter((issue) => issue.reason !== "duplicate");
	const duplicates = plan.issues.length - problems.length;
	const ready = plan.rows.length;
	const preview = plan.rows.slice(0, 5);
	const canStart =
		ready > 0 && !plan.overLimit && mapping.loomUrl !== undefined;

	const setField = (field: LoomImportField) => (value: number | undefined) =>
		setMapping((current) => ({ ...current, [field]: value }));

	const start = () => {
		startTransition(async () => {
			const result = await createLoomImportJobAction({
				orgId,
				fileName: source.name,
				rows: plan.rows,
			});
			if (!result.ok) {
				toast.error(result.error);
				return;
			}
			router.push(`/dashboard/import/loom/${result.jobId}`);
		});
	};

	return (
		<section
			aria-label="Review your import"
			className="li-scope li-rise overflow-hidden rounded-2xl border border-gray-3 bg-gray-1"
		>
			<header className="flex flex-col gap-3 border-b border-gray-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
				<div className="flex min-w-0 items-center gap-3">
					<Doodle kind="sheet" className="w-12 shrink-0" />
					<div className="min-w-0">
						<p className="truncate text-sm font-medium text-gray-12">
							{source.name}
						</p>
						<p className="text-xs text-gray-10">
							{plural(
								source.table.rows.length,
								source.pasted ? "link" : "row",
								source.pasted ? "links" : "rows",
							)}
						</p>
					</div>
				</div>
				<Button type="button" variant="gray" size="sm" onClick={onReset}>
					{source.pasted ? "Start over" : "Choose another file"}
				</Button>
			</header>

			<div className="flex flex-col gap-6 px-5 py-5 sm:px-6">
				<div>
					<p className="text-sm font-medium text-gray-12">What we found</p>
					<p className="mt-0.5 text-xs text-gray-10">
						{isAdmin
							? "Change any column if we picked the wrong one."
							: "Every video goes to your library. Only organization admins can import for teammates."}
					</p>
					<div className="mt-1 divide-y divide-gray-3">
						<MappingRow
							field="loomUrl"
							table={source.table}
							value={mapping.loomUrl}
							onChange={setField("loomUrl")}
							optional={false}
						/>
						{isAdmin && !source.pasted && (
							<>
								<MappingRow
									field="ownerEmail"
									table={source.table}
									value={mapping.ownerEmail}
									onChange={setField("ownerEmail")}
									optional
								/>
								<MappingRow
									field="spaceName"
									table={source.table}
									value={mapping.spaceName}
									onChange={setField("spaceName")}
									optional
								/>
							</>
						)}
					</div>
				</div>

				<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
					<Stat
						value={ready}
						label={ready === 1 ? "video to import" : "videos to import"}
					/>
					<Stat
						value={Math.max(plan.owners, 1)}
						label={plan.owners > 1 ? "owners" : "owner"}
					/>
					<Stat
						value={plan.spaces}
						label={plan.spaces === 1 ? "space" : "spaces"}
					/>
					<Stat
						value={problems.length}
						label={
							problems.length === 1 ? "row needs a look" : "rows need a look"
						}
						warn
					/>
				</div>

				{(problems.length > 0 || duplicates > 0) && (
					<div className="rounded-xl border border-gray-3 bg-gray-2 px-4 py-3 text-sm">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<p className="text-gray-11">
								{problems.length > 0 &&
									`${plural(problems.length, "row", "rows")} will be left out. `}
								{duplicates > 0 &&
									`${plural(duplicates, "duplicate is", "duplicates are")} skipped.`}
							</p>
							<button
								type="button"
								onClick={() => setShowIssues((open) => !open)}
								aria-expanded={showIssues}
								className="text-gray-11 underline decoration-gray-6 underline-offset-4 hover:text-gray-12"
							>
								{showIssues ? "Hide rows" : "Show rows"}
							</button>
						</div>
						{showIssues && (
							<ul className="mt-3 max-h-56 divide-y divide-gray-3 overflow-y-auto rounded-lg border border-gray-3 bg-gray-1">
								{plan.issues.slice(0, 200).map((issue) => (
									<li
										key={`${issue.rowNumber}-${issue.reason}`}
										className="grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-xs"
									>
										<span className="tabular-nums text-gray-10">
											Row {issue.rowNumber}
										</span>
										<span className="truncate font-mono text-gray-11">
											{issue.value || "Empty"}
										</span>
										<span className="text-gray-11">
											{issue.reason === "duplicate" && issue.duplicateOf
												? `Same as row ${issue.duplicateOf}`
												: LOOM_IMPORT_ISSUE_LABELS[issue.reason]}
										</span>
									</li>
								))}
							</ul>
						)}
					</div>
				)}

				{plan.overLimit && (
					<div className="flex items-start gap-4 rounded-xl border border-[#f3d29b] bg-[#fdf6e7] px-4 py-3 text-sm text-[#7a4a06] dark:border-[#5c3d0e] dark:bg-[#2a1f0d] dark:text-[#f3c675]">
						<Doodle kind="error" className="w-10 shrink-0" />
						<div>
							<p className="font-medium">
								This file has {numberFormat.format(ready)} videos. Each import
								holds up to {numberFormat.format(LOOM_IMPORT_MAX_ROWS)}.
							</p>
							<p className="mt-1">
								Split it into {Math.ceil(ready / LOOM_IMPORT_MAX_ROWS)} CSVs and
								import them one after another. They can run at the same time.
							</p>
						</div>
					</div>
				)}

				{preview.length > 0 && (
					<div className="overflow-hidden rounded-xl border border-gray-3">
						<table className="w-full table-fixed text-left text-xs">
							<thead className="bg-gray-2 text-gray-10">
								<tr>
									<th className="w-16 px-3 py-2 font-normal">Row</th>
									<th className="px-3 py-2 font-normal">Loom link</th>
									{isAdmin && !source.pasted && (
										<>
											<th className="hidden w-[30%] px-3 py-2 font-normal sm:table-cell">
												Owner
											</th>
											<th className="hidden w-[18%] px-3 py-2 font-normal sm:table-cell">
												Space
											</th>
										</>
									)}
								</tr>
							</thead>
							<tbody className="divide-y divide-gray-3">
								{preview.map((row) => (
									<tr key={row.rowNumber} className="text-gray-11">
										<td className="px-3 py-2 tabular-nums text-gray-10">
											{row.rowNumber}
										</td>
										<td className="truncate px-3 py-2 font-mono">
											{row.loomUrl}
										</td>
										{isAdmin && !source.pasted && (
											<>
												<td className="hidden truncate px-3 py-2 sm:table-cell">
													{row.ownerEmail ?? "You"}
												</td>
												<td className="hidden truncate px-3 py-2 sm:table-cell">
													{row.spaceName ?? "None"}
												</td>
											</>
										)}
									</tr>
								))}
							</tbody>
						</table>
						{ready > preview.length && (
							<p className="border-t border-gray-3 bg-gray-2 px-3 py-2 text-xs text-gray-10">
								And{" "}
								{plural(ready - preview.length, "more video", "more videos")}
							</p>
						)}
					</div>
				)}
			</div>

			<footer className="flex flex-col gap-3 border-t border-gray-3 bg-gray-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
				<p className="text-xs leading-relaxed text-gray-10">
					{isPro
						? "Next you'll see every video move across, live."
						: "On the free plan you can check your whole library now. Copying the videos into Cap needs Cap Pro."}
				</p>
				<Button
					type="button"
					variant={isPro ? "blue" : "dark"}
					size="sm"
					className="shrink-0"
					disabled={!canStart || isPending}
					spinner={isPending}
					onClick={start}
				>
					{isPro
						? `Import ${plural(ready, "video", "videos")}`
						: `Check ${plural(ready, "video", "videos")}`}
				</Button>
			</footer>
		</section>
	);
};

export const BulkImport = ({
	orgId,
	isAdmin,
	isPro,
}: {
	orgId: Organisation.OrganisationId;
	isAdmin: boolean;
	isPro: boolean;
}) => {
	const [source, setSource] = useState<Source | null>(null);
	const [howOpen, setHowOpen] = useState(false);

	return (
		<div className="flex flex-col gap-6">
			{source ? (
				<ReviewCard
					key={`${source.name}-${source.table.rows.length}`}
					source={source}
					isAdmin={isAdmin}
					isPro={isPro}
					orgId={orgId}
					onReset={() => setSource(null)}
				/>
			) : (
				<>
					<ImportGuide onHowItWorks={() => setHowOpen(true)} />
					<SourcePicker onSource={setSource} />
				</>
			)}
			<HowImportWorks open={howOpen} onOpenChange={setHowOpen} />
		</div>
	);
};
