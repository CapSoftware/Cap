import clsx from "clsx";
import {
	STORAGE_BILLING_DAYS_PER_MONTH,
	storageMicroCreditsPerMinutePerMonth,
} from "@/lib/developer-pricing";
import { getTranscriptionUsageSince } from "@/lib/developer-transcript-store";
import {
	INFRA_RESOLUTION_TIERS,
	INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
} from "@/lib/infra-pricing";
import { getAppStorageUsage } from "@/lib/infra-storage";
import {
	formatCharge,
	formatMinutes,
	INFRA_TIER_LABELS,
	summarizeStorageMonth,
	utcDaysAgoKey,
	utcMonthStart,
} from "@/lib/infra-usage";
import {
	Block,
	Empty,
	Figure,
	Figures,
	LIT,
	MONO,
	PageHeader,
	TD,
	TH,
	TR,
} from "../../_components/ui";
import {
	getInfraStorageSnapshots,
	infraPageMetadata,
	requireInfraApp,
} from "../../infra-data";

export const generateMetadata = infraPageMetadata("Usage");

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

const shortDay = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	timeZone: "UTC",
});

const asDate = (key: string) => new Date(`${key}T00:00:00Z`);

export default async function InfraUsagePage({
	params,
}: {
	params: Promise<{ appId: string }>;
}) {
	const { appId } = await params;
	const { app } = await requireInfraApp(appId);
	const now = new Date();

	const [usage, snapshots, transcription] = await Promise.all([
		getAppStorageUsage(app.id),
		getInfraStorageSnapshots(app.id, utcDaysAgoKey(now, HISTORY_DAYS)),
		getTranscriptionUsageSince(app.id, utcMonthStart(now)).catch((error) => {
			console.error("[infra-usage] Transcription usage unavailable", error);
			return null;
		}),
	]);
	const audioHours = (transcription?.audioSeconds ?? 0) / 3600;
	const storedTiers = INFRA_RESOLUTION_TIERS.filter(
		(tier) => usage.minutesByTier[tier] > 0,
	);

	const month = summarizeStorageMonth(snapshots, now);
	const monthName = monthFormat.format(utcMonthStart(now));
	const timeline = [...snapshots].reverse();
	const peak = Math.max(1, ...timeline.map((s) => s.totalDurationMinutes));
	const first = timeline[0];
	const last = timeline[timeline.length - 1];

	return (
		<>
			<PageHeader
				title="Usage"
				description="Storage is billed once a day, for each video at its resolution. Uploads and encoding are free."
			/>

			<Figures>
				<Figure
					label="Minutes stored now"
					value={formatMinutes(usage.totalMinutes)}
					lead
				/>
				<Figure
					label="Videos"
					value={usage.videoCount.toLocaleString("en-US")}
				/>
				<Figure
					label="Storage per day"
					hint="at what is stored now"
					value={formatCharge(usage.dailyMicroCredits)}
				/>
				<Figure
					label={`Storage in ${monthName}`}
					hint={`${month.billedDays} billed ${month.billedDays === 1 ? "day" : "days"}`}
					value={formatCharge(month.chargedMicroCredits)}
				/>
				{transcription && (
					<Figure
						label={`Transcription in ${monthName}`}
						hint={`${audioHours.toLocaleString("en-US", { maximumFractionDigits: audioHours < 10 ? 2 : 0 })} audio ${audioHours === 1 ? "hour" : "hours"}`}
						value={formatCharge(transcription.chargedMicroCredits)}
					/>
				)}
			</Figures>

			{first && last && timeline.length > 1 && (
				<figure className="m-0 w-fit min-w-[min(100%,220px)] max-w-full">
					<figcaption className="text-[15px] font-medium leading-[1.3] tracking-[-0.01em] text-[#E8ECF4]">
						Minutes billed per day
					</figcaption>
					<div
						role="img"
						aria-label={`Minutes billed each day, from ${formatMinutes(first.totalDurationMinutes)} on ${shortDay.format(asDate(first.snapshotDate))} to ${formatMinutes(last.totalDurationMinutes)} on ${shortDay.format(asDate(last.snapshotDate))}`}
						className="mt-6 flex h-[132px] items-end gap-[5px] border-b border-[rgba(222,230,246,0.08)]"
					>
						{timeline.map((snapshot, index) => (
							<span
								key={snapshot.snapshotDate}
								title={`${shortDay.format(asDate(snapshot.snapshotDate))}: ${formatMinutes(snapshot.totalDurationMinutes)} min`}
								style={{
									height: `${Math.max(2, (snapshot.totalDurationMinutes / peak) * 100)}%`,
								}}
								className={clsx(
									"min-w-[3px] max-w-[14px] flex-1 basis-[14px] rounded-t-[2px]",
									index === timeline.length - 1
										? LIT
										: "bg-[rgba(222,230,246,0.2)]",
								)}
							/>
						))}
					</div>
					<div
						className={clsx(
							MONO,
							"mt-3 flex justify-between text-[12px] text-[rgba(232,236,244,0.42)]",
						)}
					>
						<span>{shortDay.format(asDate(first.snapshotDate))}</span>
						<span>{shortDay.format(asDate(last.snapshotDate))}</span>
					</div>
				</figure>
			)}

			{storedTiers.length > 0 && (
				<Block
					title="Stored now"
					description={`Minutes by resolution, with the rate for each. A month is billed as ${STORAGE_BILLING_DAYS_PER_MONTH} days, one day at a time.`}
				>
					<div className="relative overflow-x-auto">
						<table className="w-full border-collapse">
							<thead>
								<tr className={TR}>
									<th className={TH}>Resolution</th>
									<th className={clsx(TH, "text-right")}>Minutes</th>
									<th className={clsx(TH, "text-right")}>
										Per 1,000 minutes a month
									</th>
									<th className={clsx(TH, "text-right")}>Per month</th>
								</tr>
							</thead>
							<tbody>
								{storedTiers.map((tier) => (
									<tr key={tier} className={TR}>
										<td className={clsx(TD, "text-[#E8ECF4]")}>
											{INFRA_TIER_LABELS[tier]}
										</td>
										<td
											className={clsx(
												TD,
												MONO,
												"text-right text-[13px] tabular-nums",
											)}
										>
											{formatMinutes(usage.minutesByTier[tier])}
										</td>
										<td
											className={clsx(
												TD,
												MONO,
												"text-right text-[13px] tabular-nums",
											)}
										>
											{`$${INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH[tier].toFixed(2)}`}
										</td>
										<td
											className={clsx(
												TD,
												MONO,
												"text-right text-[13px] tabular-nums text-[#E8ECF4]",
											)}
										>
											{formatCharge(
												usage.minutesByTier[tier] *
													storageMicroCreditsPerMinutePerMonth(tier),
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</Block>
			)}

			<Block
				title="Daily storage"
				description={`One row for each day billed, over the last ${HISTORY_DAYS} days. A row records what was stored when that day's charge was taken, so today's row can differ from what is stored now.`}
			>
				{snapshots.length === 0 ? (
					<Empty>
						Nothing billed yet. A row appears for each day this app stores
						video.
					</Empty>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full border-collapse">
							<thead>
								<tr className={TR}>
									<th className={TH}>Day</th>
									<th className={clsx(TH, "text-right")}>Minutes billed</th>
									<th className={clsx(TH, "text-right")}>Videos billed</th>
									<th className={clsx(TH, "text-right")}>Charged</th>
								</tr>
							</thead>
							<tbody>
								{snapshots.map((snapshot) => (
									<tr key={snapshot.snapshotDate} className={TR}>
										<td className={clsx(TD, "text-[#E8ECF4]")}>
											{dayFormat.format(asDate(snapshot.snapshotDate))}
										</td>
										<td
											className={clsx(
												TD,
												MONO,
												"text-right text-[13px] tabular-nums",
											)}
										>
											{formatMinutes(snapshot.totalDurationMinutes)}
										</td>
										<td
											className={clsx(
												TD,
												MONO,
												"text-right text-[13px] tabular-nums",
											)}
										>
											{snapshot.videoCount.toLocaleString("en-US")}
										</td>
										<td
											className={clsx(
												TD,
												MONO,
												"text-right text-[13px] tabular-nums text-[#E8ECF4]",
											)}
										>
											{formatCharge(snapshot.microCreditsCharged)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Block>
		</>
	);
}
