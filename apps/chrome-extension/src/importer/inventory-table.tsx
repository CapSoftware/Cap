import {
	ChevronDownIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	ExternalLinkIcon,
	FileVideoIcon,
	SearchIcon,
} from "lucide-react";
import { Fragment, useDeferredValue, useMemo, useState } from "react";
import type { InventoryRow } from "./inventory";
import type { ImportOutcome } from "./queue";

const PAGE_SIZE = 50;
type Filter = "all" | "ready" | "attention" | "selected";

export const outcomeLabel = (outcome: ImportOutcome) => {
	switch (outcome.state) {
		case "sending":
			return "Starting…";
		case "started":
			return "Started in Cap";
		case "existing":
			return "Already in Cap";
		case "failed":
			return "Not started";
		case "uncertain":
			return "Check in Cap";
	}
};

const issueLabel = (row: InventoryRow) => {
	switch (row.issue) {
		case "missing-link":
			return "Missing link";
		case "invalid-link":
			return "Invalid link";
		case "invalid-owner":
			return "Needs owner";
		case "duplicate":
			return "Duplicate";
		default:
			return row.issue
				? "Needs attention"
				: row.reviewRequired
					? "Needs review"
					: "Ready";
	}
};

export const canSubmitRow = (outcome?: ImportOutcome) =>
	!outcome || outcome.state === "failed";

export const InventoryTable = ({
	rows,
	headers,
	selected,
	outcomes,
	disabled,
	apiBaseUrl,
	onSelect,
}: {
	rows: InventoryRow[];
	headers: string[];
	selected: Set<number>;
	outcomes: Record<number, ImportOutcome>;
	disabled: boolean;
	apiBaseUrl: string;
	onSelect: (records: number[], value: boolean) => void;
}) => {
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<Filter>("all");
	const [page, setPage] = useState(0);
	const [expanded, setExpanded] = useState<number | null>(null);
	const deferredQuery = useDeferredValue(query.trim().toLowerCase());
	const filtered = useMemo(
		() =>
			rows.filter((row) => {
				if (filter === "ready" && (row.issue || row.reviewRequired))
					return false;
				if (filter === "attention" && !row.issue && !row.reviewRequired)
					return false;
				if (
					filter === "selected" &&
					(row.issue || !selected.has(row.sourceRecord))
				)
					return false;
				return (
					!deferredQuery ||
					[
						row.title,
						row.url,
						row.originalOwner,
						row.ownerEmail,
						row.spaceName,
					].some((value) => value.toLowerCase().includes(deferredQuery))
				);
			}),
		[rows, filter, selected, deferredQuery],
	);
	const currentPage = Math.min(
		page,
		Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1),
	);
	const visible = filtered.slice(
		currentPage * PAGE_SIZE,
		(currentPage + 1) * PAGE_SIZE,
	);
	const selectable = visible.filter(
		(row) =>
			!row.issue &&
			!row.reviewRequired &&
			canSubmitRow(outcomes[row.sourceRecord]),
	);
	const allSelected =
		selectable.length > 0 &&
		selectable.every((row) => selected.has(row.sourceRecord));
	return (
		<section className="inventory-section" aria-label="Video inventory">
			<div className="inventory-toolbar">
				<fieldset className="filter-tabs" aria-label="Filter inventory">
					{(
						[
							["all", "All videos"],
							["ready", "Ready"],
							["attention", "Needs attention"],
							["selected", "Selected"],
						] as const
					).map(([value, label]) => (
						<button
							type="button"
							key={value}
							aria-pressed={filter === value}
							onClick={() => {
								setFilter(value);
								setPage(0);
							}}
						>
							{label}
						</button>
					))}
				</fieldset>
				<label className="search-field">
					<SearchIcon size={16} aria-hidden />
					<input
						aria-label="Search videos"
						type="search"
						placeholder="Search videos, owners…"
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							setPage(0);
						}}
					/>
				</label>
			</div>
			<div className="table-scroll">
				<table>
					<thead>
						<tr>
							<th className="checkbox-cell" scope="col">
								<input
									type="checkbox"
									aria-label="Select ready rows on this page"
									checked={allSelected}
									disabled={disabled || !selectable.length}
									onChange={(event) =>
										onSelect(
											selectable.map((row) => row.sourceRecord),
											event.target.checked,
										)
									}
								/>
							</th>
							<th scope="col">Video</th>
							<th scope="col">Cap owner</th>
							<th scope="col">Space</th>
							<th scope="col">Status</th>
							<th scope="col">
								<span className="sr-only">Source details</span>
							</th>
						</tr>
					</thead>
					<tbody>
						{visible.map((row) => {
							const outcome = outcomes[row.sourceRecord];
							return (
								<Fragment key={row.sourceRecord}>
									<tr
										className={
											!row.issue && selected.has(row.sourceRecord)
												? "selected-row"
												: undefined
										}
									>
										<td className="checkbox-cell">
											<input
												type="checkbox"
												aria-label={`Select record ${row.sourceRecord}`}
												checked={!row.issue && selected.has(row.sourceRecord)}
												disabled={
													disabled ||
													Boolean(row.issue) ||
													!canSubmitRow(outcome)
												}
												onChange={(event) =>
													onSelect([row.sourceRecord], event.target.checked)
												}
											/>
										</td>
										<td className="video-cell">
											<div className="video-title">
												<FileVideoIcon size={17} aria-hidden />
												<span>
													{row.title ||
														`Untitled video · record ${row.sourceRecord}`}
												</span>
											</div>
											<div className="video-meta">
												{row.videoId ? (
													<a
														href={row.url}
														target="_blank"
														rel="noopener noreferrer"
													>
														View on Loom{" "}
														<ExternalLinkIcon size={11} aria-hidden />
													</a>
												) : (
													"No usable video link"
												)}
												{row.duration ? <span>{row.duration}</span> : null}
											</div>
										</td>
										<td className="owner-cell">
											<span>{row.ownerEmail || "Not assigned"}</span>
											{row.originalOwner &&
											row.originalOwner !== row.ownerEmail ? (
												<small>From {row.originalOwner}</small>
											) : null}
										</td>
										<td>
											{row.spaceName || <span className="muted">No Space</span>}
										</td>
										<td>
											<span
												className={`status-badge ${outcome ? `status-${outcome.state}` : row.issue || row.reviewRequired ? "status-attention" : "status-ready"}`}
												title={outcome?.message || row.detail}
											>
												{outcome ? outcomeLabel(outcome) : issueLabel(row)}
											</span>
											{outcome?.message ? (
												<p className="outcome-message">{outcome.message}</p>
											) : null}
											{outcome?.videoId ? (
												<a
													className="cap-result-link"
													href={new URL(
														`/s/${encodeURIComponent(outcome.videoId)}`,
														apiBaseUrl,
													).toString()}
													target="_blank"
													rel="noopener noreferrer"
												>
													Open in Cap <ExternalLinkIcon size={11} aria-hidden />
												</a>
											) : null}
										</td>
										<td>
											<button
												className="icon-button"
												type="button"
												aria-label={`Source details for record ${row.sourceRecord}`}
												aria-expanded={expanded === row.sourceRecord}
												onClick={() =>
													setExpanded(
														expanded === row.sourceRecord
															? null
															: row.sourceRecord,
													)
												}
											>
												<ChevronDownIcon size={16} aria-hidden />
											</button>
										</td>
									</tr>
									{expanded === row.sourceRecord ? (
										<tr className="source-row">
											<td colSpan={6}>
												<div className="source-details">
													<strong>Source record {row.sourceRecord}</strong>
													{outcome?.message || row.detail ? (
														<p>{outcome?.message || row.detail}</p>
													) : null}
													<dl>
														{headers.map((header, index) => (
															<div key={header}>
																<dt>{header}</dt>
																<dd>{row.raw[index] || "—"}</dd>
															</div>
														))}
													</dl>
												</div>
											</td>
										</tr>
									) : null}
								</Fragment>
							);
						})}
						{!visible.length ? (
							<tr>
								<td colSpan={6} className="empty-table">
									No videos match this view.
								</td>
							</tr>
						) : null}
					</tbody>
				</table>
			</div>
			<div className="table-footer">
				<span>
					{filtered.length
						? `${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)}`
						: "0"}{" "}
					of {filtered.length.toLocaleString()} records
				</span>
				<div>
					<button
						type="button"
						className="icon-button"
						aria-label="Previous page"
						disabled={currentPage === 0}
						onClick={() => setPage(currentPage - 1)}
					>
						<ChevronLeftIcon size={16} aria-hidden />
					</button>
					<span>
						Page {currentPage + 1} of{" "}
						{Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))}
					</span>
					<button
						type="button"
						className="icon-button"
						aria-label="Next page"
						disabled={(currentPage + 1) * PAGE_SIZE >= filtered.length}
						onClick={() => setPage(currentPage + 1)}
					>
						<ChevronRightIcon size={16} aria-hidden />
					</button>
				</div>
			</div>
		</section>
	);
};
