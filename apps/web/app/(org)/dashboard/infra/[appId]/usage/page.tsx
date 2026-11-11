import type { Metadata } from "next";
import { STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH } from "@/lib/developer-pricing";
import {
	formatCharge,
	formatMinutes,
	summarizeStorageMonth,
	utcDaysAgoKey,
	utcMonthStart,
} from "@/lib/infra-usage";
import { Metric, Panel, Section } from "../../_components/section";
import {
	getDeveloperUsageSummary,
	getInfraStorageSnapshots,
	requireInfraApp,
} from "../../infra-data";

export const metadata: Metadata = {
	title: "Usage | Cap Infra",
};

const HISTORY_DAYS = 60;

const monthFormat = new Intl.DateTimeFormat("en-US", {
	month: "long",
	timeZone: "UTC",
});

const dayFormat = new Intl.DateTimeFormat("en-US", {
	weekday: "short",
	month: "short",
	day: "numeric",
	timeZone: "UTC",
});

export default async function InfraUsagePage({
	params,
}: {
	params: Promise<{ appId: string }>;
}) {
	const { appId } = await params;
	const { app } = await requireInfraApp(appId);
	const now = new Date();

	const [usage, snapshots] = await Promise.all([
		getDeveloperUsageSummary(app.id),
		getInfraStorageSnapshots(app.id, utcDaysAgoKey(now, HISTORY_DAYS)),
	]);

	const month = summarizeStorageMonth(snapshots, now);
	const monthName = monthFormat.format(utcMonthStart(now));

	return (
		<>
			<Panel className="grid sm:grid-cols-3">
				<Metric
					className="p-5"
					label="Stored now"
					value={`${formatMinutes(usage.totalDurationMinutes)} min`}
				/>
				<Metric
					className="p-5 border-t sm:border-t-0 sm:border-l border-gray-3"
					label="Videos"
					value={usage.totalVideos.toLocaleString("en-US")}
				/>
				<Metric
					className="p-5 border-t sm:border-t-0 sm:border-l border-gray-3"
					label={`Storage in ${monthName}`}
					value={formatCharge(month.chargedMicroCredits)}
					hint={`${month.billedDays} billed ${month.billedDays === 1 ? "day" : "days"}`}
				/>
			</Panel>

			<Section
				title="Daily storage"
				description={`Billed once a day at $${STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH.toFixed(2)} per 1,000 minutes per month. Last ${HISTORY_DAYS} days.`}
			>
				<Panel>
					{snapshots.length === 0 ? (
						<p className="px-5 py-10 text-sm text-center text-gray-10">
							Nothing billed yet. A row appears for each day this app stores
							video.
						</p>
					) : (
						<div className="overflow-x-auto">
							<table className="w-full text-sm">
								<thead>
									<tr className="border-b border-gray-3">
										<th className="py-2.5 pr-4 pl-5 font-normal text-left text-gray-10">
											Day
										</th>
										<th className="px-4 py-2.5 font-normal text-right text-gray-10">
											Minutes stored
										</th>
										<th className="px-4 py-2.5 font-normal text-right text-gray-10">
											Videos
										</th>
										<th className="py-2.5 pr-5 pl-4 font-normal text-right text-gray-10">
											Charged
										</th>
									</tr>
								</thead>
								<tbody>
									{snapshots.map((snapshot) => (
										<tr
											key={snapshot.snapshotDate}
											className="border-b border-gray-3 last:border-0"
										>
											<td className="py-2.5 pr-4 pl-5 whitespace-nowrap text-gray-12">
												{dayFormat.format(
													new Date(`${snapshot.snapshotDate}T00:00:00Z`),
												)}
											</td>
											<td className="px-4 py-2.5 text-right tabular-nums text-gray-11">
												{formatMinutes(snapshot.totalDurationMinutes)}
											</td>
											<td className="px-4 py-2.5 text-right tabular-nums text-gray-11">
												{snapshot.videoCount.toLocaleString("en-US")}
											</td>
											<td className="py-2.5 pr-5 pl-4 text-right tabular-nums text-gray-12">
												{formatCharge(snapshot.microCreditsCharged)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</Panel>
			</Section>
		</>
	);
}
