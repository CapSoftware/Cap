import { buttonVariants } from "@cap/ui";
import { classNames } from "@cap/utils";
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
import { ApiKeyDisplay } from "../_components/api-key-display";
import { CodeBlock } from "../_components/code-block";
import { listVideosCurl } from "../_components/infra-examples";
import { Metric, Panel, Section } from "../_components/section";
import {
	getDeveloperAppVideos,
	getDeveloperUsageSummary,
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

	const [usage, monthStorageCharges, recentVideos] = await Promise.all([
		getDeveloperUsageSummary(app.id),
		app.creditAccount
			? getInfraStorageChargesSince(app.creditAccount.id, monthStart)
			: Promise.resolve(0),
		getDeveloperAppVideos(app.id, { limit: 5 }),
	]);

	const balance = app.creditAccount?.balanceMicroCredits ?? 0;
	const publicKey = app.apiKeys.find((k) => k.keyType === "public");

	return (
		<>
			<Panel className="grid md:grid-cols-[1.3fr_1fr_1fr_1fr]">
				<div className="flex flex-col gap-3 p-5">
					<span className="text-sm text-gray-10">Credit balance</span>
					<span className="text-3xl font-medium tabular-nums text-gray-12">
						{formatCredits(balance)}
					</span>
					<Link
						href={infraAppPath(app.id, "billing")}
						className={classNames(
							buttonVariants({ variant: "dark", size: "sm" }),
							"self-start",
						)}
					>
						Add credits
					</Link>
				</div>
				<Metric
					className="p-5 border-t md:border-t-0 md:border-l border-gray-3"
					label="Stored"
					value={`${formatMinutes(usage.totalDurationMinutes)} min`}
					hint="Across all videos"
				/>
				<Metric
					className="p-5 border-t md:border-t-0 md:border-l border-gray-3"
					label="Videos"
					value={usage.totalVideos.toLocaleString("en-US")}
					hint="In this app"
				/>
				<Metric
					className="p-5 border-t md:border-t-0 md:border-l border-gray-3"
					label="Storage charges"
					value={formatCharge(monthStorageCharges)}
					hint={`So far in ${monthFormat.format(monthStart)}`}
				/>
			</Panel>

			<div className="grid gap-6 lg:grid-cols-2">
				<Section
					title="Recent videos"
					action={
						recentVideos.length > 0 ? (
							<Link
								href={infraAppPath(app.id, "videos")}
								className="text-sm text-gray-10 hover:text-gray-12"
							>
								View all
							</Link>
						) : undefined
					}
				>
					<Panel>
						{recentVideos.length === 0 ? (
							<div className="flex flex-col gap-1 p-5">
								<p className="text-sm text-gray-12">No videos yet.</p>
								<p className="text-sm text-gray-10">
									Videos created with your public key show up here.{" "}
									<Link
										href={infraAppPath(app.id, "videos")}
										className="underline underline-offset-2 hover:text-gray-12"
									>
										See how
									</Link>
								</p>
							</div>
						) : (
							<ul>
								{recentVideos.map((video) => (
									<li
										key={video.id}
										className="flex gap-4 justify-between items-center px-5 py-3 border-b border-gray-3 last:border-0"
									>
										<div className="flex flex-col min-w-0">
											<span className="text-sm truncate text-gray-12">
												{video.name}
											</span>
											<span className="text-xs truncate text-gray-10">
												{video.externalUserId ?? "No user id"}
											</span>
										</div>
										<div className="flex flex-col items-end text-xs tabular-nums shrink-0 text-gray-10">
											<span className="text-gray-11">
												{formatDuration(video.duration) ?? "Pending"}
											</span>
											<span>
												{dateFormat.format(new Date(video.createdAt))}
											</span>
										</div>
									</li>
								))}
							</ul>
						)}
					</Panel>
				</Section>

				<Section title="Quick start">
					<Panel className="flex flex-col gap-5 p-5">
						{publicKey && (
							<ApiKeyDisplay
								label="Public key"
								value={publicKey.fullKey ?? `${publicKey.keyPrefix}...`}
							/>
						)}
						<div className="flex flex-col gap-1.5">
							<span className="text-xs font-medium text-gray-12">
								Secret key
							</span>
							<p className="text-sm leading-6 text-gray-10">
								Shown once, when the app or its keys were created. Keep it on
								your server. Lost it? Generate a new pair in{" "}
								<Link
									href={infraAppPath(app.id, "keys")}
									className="underline underline-offset-2 text-gray-11 hover:text-gray-12"
								>
									API keys
								</Link>
								.
							</p>
						</div>
						<div className="flex flex-col gap-1.5">
							<span className="text-xs font-medium text-gray-12">
								List your videos
							</span>
							<CodeBlock code={listVideosCurl()} label="curl example" />
						</div>
					</Panel>
				</Section>
			</div>
		</>
	);
}
