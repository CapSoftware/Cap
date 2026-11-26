"use client";

import { faArrowsRotate } from "@fortawesome/free-solid-svg-icons/faArrowsRotate";
import { faUsers } from "@fortawesome/free-solid-svg-icons/faUsers";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import Link from "next/link";
import { type ReactNode, useId, useState } from "react";
import { getLoomImportOverview } from "@/actions/loom-import-overview";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";
import type {
	LoomImportFailureReason,
	LoomImportState,
} from "@/lib/loom-import-status";

const STATE_LABELS: Record<LoomImportState, string> = {
	queued: "Queued",
	importing: "Importing",
	done: "Done",
	failed: "Failed",
};

const STATE_TONES: Record<LoomImportState, string> = {
	queued: "bg-gray-3 text-gray-11",
	importing: "bg-blue-3 text-blue-11",
	done: "bg-gray-3 text-gray-11",
	failed: "bg-red-transparent-20 text-red-400",
};

const FAILURE_REASONS: Record<LoomImportFailureReason, string> = {
	retrying: "Cap was busy and will try again on its own",
	source: "Loom's copy was missing or incomplete",
	stopped: "Stopped before it finished",
};

const ACTIVE_REFRESH_MS = 15_000;
const ATTENTION_PREVIEW = 6;

const formatCount = (value: number) => value.toLocaleString("en-US");

const dateFormatter = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
});

function StatePill({ state }: { state: LoomImportState }) {
	return (
		<span
			className={clsx(
				"inline-flex items-center px-2 h-6 text-xs font-medium rounded-full whitespace-nowrap",
				STATE_TONES[state],
			)}
		>
			{STATE_LABELS[state]}
		</span>
	);
}

function CountCell({
	value,
	state,
}: {
	value: number;
	state: LoomImportState;
}) {
	return (
		<td
			className={clsx(
				"px-3 py-2.5 text-right tabular-nums",
				value === 0
					? "text-gray-8"
					: state === "failed"
						? "font-medium text-red-400"
						: "text-gray-12",
			)}
		>
			{formatCount(value)}
		</td>
	);
}

export function LoomImportStatus({
	organizationId,
}: {
	organizationId: string;
}) {
	const titleId = useId();
	const [showAllAttention, setShowAllAttention] = useState(false);
	const query = useQuery({
		queryKey: ["loom-import-overview", organizationId],
		queryFn: () => getLoomImportOverview(organizationId),
		refetchInterval: (current) => {
			const totals = current.state.data?.totals;
			return totals && totals.queued + totals.importing > 0
				? ACTIVE_REFRESH_MS
				: false;
		},
		refetchOnWindowFocus: true,
	});

	const data = query.data;
	const header = (
		<div className="flex gap-4 justify-between items-start px-6 py-5">
			<div className="flex gap-3 items-start">
				<div className="flex justify-center items-center rounded-full size-8 bg-gray-3 shrink-0">
					<FontAwesomeIcon icon={faUsers} className="size-3.5 text-gray-11" />
				</div>
				<div className="flex flex-col gap-1">
					<h2 id={titleId} className="text-sm font-medium text-gray-12">
						Imports across your team
					</h2>
					<p className="text-xs text-gray-10">
						Every Loom video imported into this organization, by owner.
					</p>
				</div>
			</div>
			<button
				type="button"
				onClick={() => void query.refetch()}
				disabled={query.isFetching}
				aria-label="Refresh import status"
				className="flex justify-center items-center rounded-lg transition-colors size-8 text-gray-10 hover:bg-gray-3 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 disabled:opacity-60"
			>
				<FontAwesomeIcon
					icon={faArrowsRotate}
					className={clsx("size-3.5", query.isFetching && "animate-spin")}
				/>
			</button>
		</div>
	);
	const shell = (children: ReactNode) => (
		<section
			aria-labelledby={titleId}
			aria-busy={query.isPending || undefined}
			className="flex overflow-hidden flex-col rounded-xl border bg-gray-1 border-gray-3"
		>
			{header}
			{children}
		</section>
	);

	if (query.isPending) {
		return shell(
			<p className="px-6 pt-1 pb-5 text-sm text-gray-10">
				Loading your team's imports...
			</p>,
		);
	}
	if (query.isError) {
		return (
			<section className="flex justify-between items-center px-6 py-5 rounded-xl border bg-gray-1 border-gray-3">
				<p className="text-sm text-gray-11">
					Couldn't load your team's Loom imports.
				</p>
				<button
					type="button"
					onClick={() => void query.refetch()}
					className="text-sm font-medium rounded-md text-gray-12 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9"
				>
					Try again
				</button>
			</section>
		);
	}
	if (!data || data.totals.total === 0) {
		return shell(
			<p className="px-6 pt-1 pb-5 text-sm text-gray-10">
				No Loom imports yet. Anything your team imports shows up here.
			</p>,
		);
	}

	return shell(
		<>
			<dl className="grid grid-cols-2 gap-px border-y sm:grid-cols-4 bg-gray-3 border-gray-3">
				{(["done", "importing", "queued", "failed"] as const).map((state) => (
					<div key={state} className="flex flex-col gap-1 px-6 py-4 bg-gray-1">
						<dt className="text-xs text-gray-10">{STATE_LABELS[state]}</dt>
						<dd
							className={clsx(
								"text-xl font-medium tabular-nums",
								state === "failed" && data.totals.failed > 0
									? "text-red-400"
									: "text-gray-12",
							)}
						>
							{formatCount(data.totals[state])}
						</dd>
					</div>
				))}
			</dl>

			<div className="overflow-x-auto">
				<table className="w-full text-sm min-w-[560px]">
					<caption className="sr-only">Loom imports by member</caption>
					<thead>
						<tr className="text-xs text-left text-gray-10">
							<th scope="col" className="px-6 py-2.5 font-normal">
								Member
							</th>
							<th scope="col" className="px-3 py-2.5 font-normal text-right">
								Done
							</th>
							<th scope="col" className="px-3 py-2.5 font-normal text-right">
								Importing
							</th>
							<th scope="col" className="px-3 py-2.5 font-normal text-right">
								Queued
							</th>
							<th scope="col" className="px-3 py-2.5 font-normal text-right">
								Failed
							</th>
							<th
								scope="col"
								className="py-2.5 pr-6 pl-3 font-normal text-right"
							>
								Last import
							</th>
						</tr>
					</thead>
					<tbody>
						{data.members.map((member) => (
							<tr key={member.userId} className="border-t border-gray-3">
								<td className="px-6 py-2.5 max-w-0">
									<p className="truncate text-gray-12">
										{member.name || member.email}
									</p>
									{member.name && (
										<p className="text-xs truncate text-gray-10">
											{member.email}
										</p>
									)}
								</td>
								<CountCell value={member.done} state="done" />
								<CountCell value={member.importing} state="importing" />
								<CountCell value={member.queued} state="queued" />
								<CountCell value={member.failed} state="failed" />
								<td className="py-2.5 pr-6 pl-3 text-right whitespace-nowrap text-gray-10">
									{member.lastImportedAt
										? dateFormatter.format(new Date(member.lastImportedAt))
										: ""}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			{data.attention.length > 0 && (
				<div className="flex flex-col border-t border-gray-3">
					<p className="px-6 pt-4 pb-2 text-xs text-gray-10">
						Still in progress or failed
					</p>
					<ul className="flex flex-col pb-2">
						{(showAllAttention
							? data.attention
							: data.attention.slice(0, ATTENTION_PREVIEW)
						).map((row) => (
							<li
								key={row.videoId}
								className="flex gap-3 justify-between items-center px-6 py-2"
							>
								<span className="flex flex-col min-w-0">
									<span className="text-sm truncate text-gray-12">
										{row.name}
									</span>
									<span className="text-xs truncate text-gray-10">
										{[
											row.ownedByViewer ? "You" : row.ownerName,
											row.failureReason
												? FAILURE_REASONS[row.failureReason]
												: null,
										]
											.filter(Boolean)
											.join(" · ")}
									</span>
								</span>
								<span className="flex gap-2 items-center shrink-0">
									{row.state === "failed" &&
										row.ownedByViewer &&
										row.failureReason !== "retrying" && (
											<Link
												href={`/s/${row.videoId}`}
												aria-label={`Open ${row.name}`}
												className="px-2.5 h-6 text-xs font-medium leading-6 rounded-full border transition-colors border-gray-4 text-gray-12 hover:bg-gray-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9"
											>
												Open
											</Link>
										)}
									<StatePill state={row.state} />
								</span>
							</li>
						))}
					</ul>
					{data.attention.length > ATTENTION_PREVIEW && (
						<button
							type="button"
							onClick={() => setShowAllAttention((current) => !current)}
							className="self-start px-6 pb-4 text-xs font-medium rounded-md text-gray-11 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9"
						>
							{showAllAttention
								? "Show fewer"
								: `Show ${data.attention.length - ATTENTION_PREVIEW} more`}
						</button>
					)}
				</div>
			)}
		</>,
	);
}
