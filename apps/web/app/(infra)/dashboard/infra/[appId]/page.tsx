import clsx from "clsx";
import type { Metadata } from "next";
import Link from "next/link";
import { infraAppPath } from "@/lib/infra-routes";
import {
	formatCharge,
	formatCredits,
	formatDuration,
	formatMinutes,
	utcMonthStart,
} from "@/lib/infra-usage";
import { AgentSetup } from "../_components/agent-setup";
import { KeyRow } from "../_components/copy";
import { GetStarted } from "../_components/get-started";
import {
	Block,
	ButtonLink,
	EnvTag,
	Figure,
	Figures,
	MONO,
	TEXT_LINK,
} from "../_components/ui";
import {
	getDeveloperAppVideos,
	getDeveloperUsageSummary,
	getInfraProCredit,
	getInfraStorageChargesSince,
	requireInfraApp,
} from "../infra-data";

export const metadata: Metadata = {
	title: "Overview | Cap Infra",
};

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

	const [usage, monthStorageCharges, recentVideos, proCredit] =
		await Promise.all([
			getDeveloperUsageSummary(app.id),
			app.creditAccount
				? getInfraStorageChargesSince(app.creditAccount.id, monthStart)
				: Promise.resolve(0),
			getDeveloperAppVideos(app.id, { limit: 6 }),
			getInfraProCredit(),
		]);

	const balance = app.creditAccount?.balanceMicroCredits ?? 0;
	const publicKey = app.apiKeys.find((k) => k.keyType === "public");
	const secretKey = app.apiKeys.find((k) => k.keyType === "secret");
	const publicKeyValue = publicKey
		? (publicKey.fullKey ?? `${publicKey.keyPrefix}...`)
		: "cpk_...";
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
				{!empty && (
					<ButtonLink variant="ghost" href={infraAppPath(app.id, "billing")}>
						Add credits
					</ButtonLink>
				)}
			</header>

			<Figures>
				<Figure label="Credit balance" value={formatCredits(balance)} lead />
				<Figure
					label="Minutes stored"
					value={formatMinutes(usage.totalDurationMinutes)}
				/>
				<Figure
					label="Videos"
					value={usage.totalVideos.toLocaleString("en-US")}
				/>
				<Figure
					label={`Storage in ${monthFormat.format(monthStart)}`}
					value={formatCharge(monthStorageCharges)}
				/>
			</Figures>

			<div className="grid gap-x-16 gap-y-12 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
				{empty ? (
					<section className="min-w-0">
						<h2 className="m-0 text-[15px] font-medium leading-[1.3] tracking-[-0.01em] text-[#E8ECF4]">
							Upload your first video
						</h2>
						<p className="m-0 mb-7 mt-1 text-[13.5px] leading-[1.55] text-[rgba(232,236,244,0.58)]">
							It shows up here as soon as it exists.
						</p>
						<GetStarted
							appId={app.id}
							publicKey={publicKeyValue}
							isProduction={app.environment === "production"}
							balanceMicroCredits={balance}
							proCredit={proCredit}
						/>
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
						<ul className="m-0 list-none p-0">
							{recentVideos.map((video) => (
								<li
									key={video.id}
									className="flex items-baseline justify-between gap-6 border-b border-[rgba(222,230,246,0.07)] py-3"
								>
									<div className="min-w-0">
										<p className="m-0 truncate text-[14px] leading-[1.4] text-[#E8ECF4]">
											{video.name}
										</p>
										<p
											className={clsx(
												MONO,
												"m-0 mt-0.5 truncate text-[12px] leading-[1.4] text-[rgba(232,236,244,0.4)]",
											)}
										>
											{video.externalUserId ?? "no user id"}
										</p>
									</div>
									<div className="flex shrink-0 items-baseline gap-5">
										<span
											className={clsx(
												MONO,
												"text-[13px] tabular-nums text-[rgba(232,236,244,0.86)]",
											)}
										>
											{formatDuration(video.duration) ?? "pending"}
										</span>
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
						title="Keys"
						action={
							<Link
								href={infraAppPath(app.id, "keys")}
								className={clsx(
									TEXT_LINK,
									"text-[13px] text-[rgba(232,236,244,0.58)]",
								)}
							>
								Manage keys
							</Link>
						}
					>
						<KeyRow label="Public key" value={publicKeyValue} />
						<KeyRow
							label="Secret key"
							value={`${secretKey?.keyPrefix ?? "csk_"}${"•".repeat(24)}`}
							copyable={false}
						/>
						<p className="m-0 mt-3 text-pretty text-[13px] leading-[1.55] text-[rgba(232,236,244,0.46)]">
							The secret key was shown once when it was created. Lost it?
							Generate a new pair.
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
