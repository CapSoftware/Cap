"use client";

import clsx from "clsx";
import { formatDistanceToNowStrict } from "date-fns";
import Link from "next/link";
import { useId } from "react";
import type { LoomImportJobSummary } from "@/lib/loom-import/jobs";

const numberFormat = new Intl.NumberFormat("en-US");

function describe(job: LoomImportJobSummary) {
	switch (job.status) {
		case "checking":
			return "Checking links";
		case "awaiting_upgrade":
			return "Ready, waiting for Cap Pro";
		case "importing":
			return `${numberFormat.format(job.imported)} of ${numberFormat.format(job.totalCount)} imported`;
		case "completed":
			return job.failed > 0
				? `${numberFormat.format(job.imported)} imported, ${numberFormat.format(job.failed)} failed`
				: `${numberFormat.format(job.imported)} imported`;
		case "cancelled":
			return `Stopped after ${numberFormat.format(job.imported)}`;
		default:
			return "";
	}
}

export const RecentImports = ({ jobs }: { jobs: LoomImportJobSummary[] }) => {
	const headingId = useId();
	if (jobs.length === 0) return null;
	return (
		<section aria-labelledby={headingId} className="flex flex-col gap-3">
			<h2 id={headingId} className="text-sm font-medium text-gray-12">
				Your recent imports
			</h2>
			<ul className="divide-y divide-gray-3 overflow-hidden rounded-xl border border-gray-3 bg-gray-1">
				{jobs.map((job) => {
					const progress =
						job.totalCount > 0 ? Math.min(1, job.settled / job.totalCount) : 0;
					const active =
						job.status === "importing" || job.status === "checking";
					return (
						<li key={job.id}>
							<Link
								href={`/dashboard/import/loom/${job.id}`}
								className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-gray-2 focus-visible:bg-gray-2 focus-visible:outline-none sm:grid-cols-[minmax(0,1fr)_160px_auto]"
							>
								<div className="min-w-0">
									<p className="truncate text-sm text-gray-12">
										{job.fileName}
									</p>
									<p className="text-xs text-gray-10" suppressHydrationWarning>
										{numberFormat.format(job.totalCount)}{" "}
										{job.totalCount === 1 ? "video" : "videos"} ·{" "}
										{formatDistanceToNowStrict(new Date(job.createdAt), {
											addSuffix: true,
										})}
									</p>
								</div>
								<div className="col-span-2 row-start-2 h-1.5 overflow-hidden rounded-full bg-gray-3 sm:col-span-1 sm:row-start-auto">
									<div
										className={clsx(
											"h-full rounded-full",
											job.status === "completed"
												? "bg-[#2f9e69]"
												: job.status === "cancelled"
													? "bg-gray-8"
													: "bg-blue-9",
										)}
										style={{ width: `${Math.round(progress * 100)}%` }}
									/>
								</div>
								<span
									className={clsx(
										"text-right text-xs tabular-nums",
										active ? "text-gray-12" : "text-gray-10",
									)}
								>
									{describe(job)}
								</span>
							</Link>
						</li>
					);
				})}
			</ul>
		</section>
	);
};
