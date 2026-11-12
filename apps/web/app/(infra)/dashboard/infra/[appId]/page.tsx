import clsx from "clsx";
import Link from "next/link";
import { infraAppPath } from "@/lib/infra-routes";
import { getInfraBilling } from "@/lib/infra-standing";
import { getAppStorageUsage } from "@/lib/infra-storage";
import {
	formatCharge,
	formatCredits,
	formatDuration,
	formatMinutes,
	utcMonthStart,
} from "@/lib/infra-usage";
import { AgentSetup } from "../_components/agent-setup";
import { KeyRow } from "../_components/copy";
import { ApiGuide, FirstCredit } from "../_components/get-started";
import { StandingNotice } from "../_components/standing-notice";
import {
	Block,
	ButtonLink,
	EnvTag,
	Figure,
	Figures,
	FOCUS,
	MONO,
	TEXT_LINK,
} from "../_components/ui";
import { UploadDrop } from "../_components/upload-drop";
import { LiveVideoStatus, WatchVideos } from "../_components/video-live";
import {
	getDeveloperAppVideos,
	getInfraProCredit,
	getInfraStorageChargesSince,
	infraPageMetadata,
	requireInfraApp,
} from "../infra-data";

export const generateMetadata = infraPageMetadata("Overview");

const monthFormat = new Intl.DateTimeFormat("en-US", {
	month: "long",
	timeZone: "UTC",
});

const dateFormat = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	timeZone: "UTC",
});

export default async function InfraOverviewPage({
	params,
}: {
	params: Promise<{ appId: string }>;
}) {
	const { appId } = await params;
	const { app } = await requireInfraApp(appId);
	const monthStart = utcMonthStart(new Date());

	const [usage, monthStorageCharges, recentVideos, proCredit, billing] =
		await Promise.all([
			getAppStorageUsage(app.id),
			app.creditAccount
				? getInfraStorageChargesSince(app.creditAccount.id, monthStart)
				: Promise.resolve(0),
			getDeveloperAppVideos(app.id, { limit: 6 }),
			getInfraProCredit(),
			getInfraBilling(app.id),
		]);

	const balance = app.creditAccount?.balanceMicroCredits ?? 0;
	const secretKey = app.apiKeys.find((k) => k.keyType === "secret");
	const empty = recentVideos.length === 0;

	return (
		<>
			<header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
				<div className="min-w-0">
					<h1 className="m-0 truncate text-[26px] font-medium leading-[1.15] tracking-[-0.03em] text-[#E8ECF4]">
						{app.name}
					</h1>
					<EnvTag environment={app.environment} className="mt-3" />
				</div>
				{!empty && billing.standing.state === "active" && (
					<ButtonLink variant="ghost" href={infraAppPath(app.id, "billing")}>
						Add credits
					</ButtonLink>
				)}
			</header>

			<StandingNotice
				appId={app.id}
				standing={billing.standing}
				shortfallMicroCredits={billing.admission.shortfallMicroCredits}
				action
			/>

			<Figures>
				<Figure label="Credit balance" value={formatCredits(balance)} lead />
				<Figure
					label="Minutes stored"
					value={formatMinutes(usage.totalMinutes)}
				/>
				<Figure
					label="Videos"
					value={usage.videoCount.toLocaleString("en-US")}
				/>
				<Figure
					label={`Storage in ${monthFormat.format(monthStart)}`}
					value={formatCharge(monthStorageCharges)}
				/>
			</Figures>

			<div className="grid gap-x-16 gap-y-12 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
				{empty ? (
					<section className="flex min-w-0 flex-col gap-6">
						<div>
							<h2 className="m-0 text-[15px] font-medium leading-[1.3] tracking-[-0.01em] text-[#E8ECF4]">
								Upload your first video
							</h2>
							<p className="m-0 mt-1 text-pretty text-[13.5px] leading-[1.55] text-[rgba(232,236,244,0.58)]">
								Drop it in. Once it has processed you can watch it here and copy
								the links that play it on your site.
							</p>
						</div>
						<UploadDrop />
						<FirstCredit
							appId={app.id}
							balanceMicroCredits={balance}
							proCredit={proCredit}
						/>
						<ApiGuide />
					</section>
				) : (
					<Block
						title="Recent videos"
						action={
							<Link
								href={infraAppPath(app.id, "videos")}
								className={clsx(
									TEXT_LINK,
									"text-[13px] text-[rgba(232,236,244,0.58)]",
								)}
							>
								All videos
							</Link>
						}
					>
						<WatchVideos
							videos={recentVideos.map((video) => ({
								id: video.id,
								state: video.state,
								createdAt: video.createdAt,
							}))}
						/>
						<ul className="m-0 list-none p-0">
							{recentVideos.map((video) => (
								<li
									key={video.id}
									className="flex items-baseline justify-between gap-6 border-b border-[rgba(222,230,246,0.07)] py-3"
								>
									<div className="min-w-0">
										<Link
											href={`${infraAppPath(app.id, "videos")}/${encodeURIComponent(video.id)}`}
											className={clsx(
												"block truncate rounded-[4px] text-[14px] leading-[1.4] text-[#E8ECF4] underline-offset-[4px] hover:underline",
												FOCUS,
											)}
										>
											{video.name}
										</Link>
										{video.externalUserId && (
											<p
												className={clsx(
													MONO,
													"m-0 mt-0.5 truncate text-[12px] leading-[1.4] text-[rgba(232,236,244,0.4)]",
												)}
											>
												{video.externalUserId}
											</p>
										)}
									</div>
									<div className="flex shrink-0 items-baseline gap-5">
										{video.state === "ready" ? (
											<span
												className={clsx(
													MONO,
													"text-[13px] tabular-nums text-[rgba(232,236,244,0.86)]",
												)}
											>
												{formatDuration(video.duration)}
											</span>
										) : (
											<LiveVideoStatus
												video={{
													id: video.id,
													state: video.state,
													createdAt: video.createdAt,
												}}
											/>
										)}
										<span className="w-12 text-right text-[12.5px] text-[rgba(232,236,244,0.42)]">
											{dateFormat.format(new Date(video.createdAt))}
										</span>
									</div>
								</li>
							))}
						</ul>
					</Block>
				)}

				<div className="flex min-w-0 flex-col gap-10">
					<Block
						title="Secret key"
						action={
							<Link
								href={infraAppPath(app.id, "keys")}
								className={clsx(
									TEXT_LINK,
									"text-[13px] text-[rgba(232,236,244,0.58)]",
								)}
							>
								Manage key
							</Link>
						}
					>
						<KeyRow
							label="Secret key"
							value={`${secretKey?.keyPrefix ?? "csk_"}${"•".repeat(24)}`}
							copyable={false}
						/>
						<p className="m-0 mt-3 text-pretty text-[13px] leading-[1.55] text-[rgba(232,236,244,0.46)]">
							It belongs on your server and was shown once, when it was created.
							Lost it? Generate a new one.
						</p>
					</Block>
					<Block title="Use it with your agent">
						<AgentSetup />
					</Block>
				</div>
			</div>
		</>
	);
}
