"use client";

import { Button } from "@cap/ui";
import NumberFlow from "@number-flow/react";
import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { useCurrency } from "hooks/useCurrency";
import { useId, useState } from "react";
import { toast } from "sonner";
import { useStripeContext } from "@/app/Layout/StripeContext";
import { UpgradeModal } from "@/components/UpgradeModal";
import { PRICING } from "@/data/pricing";
import { Boil, Doodle, delay } from "../_components/doodles";

const numberFormat = new Intl.NumberFormat("en-US");
const ANNUAL_SAVINGS = Math.round(
	(1 - PRICING.pro.annualPerMonth / PRICING.pro.monthly) * 100,
);

export function formatHours(seconds: number) {
	if (seconds <= 0) return "0m";
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.round((seconds % 3600) / 60);
	if (hours === 0) return `${Math.max(minutes, 1)}m`;
	return minutes > 0
		? `${numberFormat.format(hours)}h ${minutes}m`
		: `${numberFormat.format(hours)}h`;
}

const PERKS = [
	"Every video, any length, unlimited storage",
	"Original titles and recording dates kept",
	"AI summaries and chapters the first time a video is watched",
	"Custom domain, passwords and viewer analytics",
];

const InkCheck = ({ at }: { at: number }) => (
	<svg
		viewBox="0 0 20 20"
		className="mt-0.5 size-4 shrink-0"
		aria-hidden="true"
	>
		<Boil scale={1.4}>
			<path
				className="li-ink is-accent li-draw"
				pathLength={1}
				style={{ ...delay(at), strokeWidth: 2.2 }}
				d="M 4 10.5 L 8 14.5 L 16 5.5"
			/>
		</Boil>
	</svg>
);

export const UpgradePanel = ({
	jobId,
	videoCount,
	totalDuration,
	owners,
	thumbs,
	confirming,
	canStart,
	starting,
	onStart,
}: {
	jobId: string;
	videoCount: number;
	totalDuration: number;
	owners: number;
	thumbs: string[];
	confirming: boolean;
	canStart: boolean;
	starting: boolean;
	onStart: () => void;
}) => {
	const stripe = useStripeContext();
	const { currency } = useCurrency();
	const [annual, setAnnual] = useState(true);
	const [compareOpen, setCompareOpen] = useState(false);
	const titleId = useId();
	const perMonth = annual ? PRICING.pro.annualPerMonth : PRICING.pro.monthly;

	const checkout = useMutation({
		mutationFn: async () => {
			const response = await fetch("/api/settings/billing/subscribe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					priceId: stripe.plans[annual ? "yearly" : "monthly"],
					quantity: 1,
					returnTo: `/dashboard/import/loom/${jobId}`,
				}),
			});
			const data = (await response.json().catch(() => ({}))) as {
				url?: string;
				subscription?: boolean;
			};
			if (data.subscription) {
				window.location.reload();
				return;
			}
			if (!data.url) throw new Error("Checkout unavailable");
			window.location.href = data.url;
		},
		onError: () => {
			toast.error("We couldn't open checkout. Please try again.");
		},
	});

	if (confirming || canStart) {
		return (
			<section className="li-scope li-rise flex flex-col items-center gap-4 rounded-2xl border border-gray-3 bg-gray-1 px-6 py-10 text-center">
				<Doodle kind={canStart ? "unlock" : "magnify"} className="w-32" />
				<div className="flex max-w-md flex-col gap-1.5">
					<h2 className="text-lg font-medium text-gray-12">
						{canStart ? "You're on Cap Pro" : "Confirming your upgrade"}
					</h2>
					<p className="text-sm text-gray-10">
						{canStart
							? `${numberFormat.format(videoCount)} videos are checked and ready to copy into Cap.`
							: "This usually takes a few seconds. Your import starts on its own once it's done."}
					</p>
				</div>
				{canStart && (
					<Button
						type="button"
						variant="blue"
						size="sm"
						spinner={starting}
						disabled={starting}
						onClick={onStart}
					>
						Start importing
					</Button>
				)}
			</section>
		);
	}

	return (
		<section
			aria-labelledby={titleId}
			className="li-scope li-rise grid overflow-hidden rounded-2xl border border-gray-3 bg-gray-1 md:grid-cols-[minmax(0,1fr)_340px]"
		>
			<div className="flex flex-col gap-6 p-6 sm:p-8">
				<div className="flex items-start gap-4">
					<Doodle kind="unlock" className="w-24 shrink-0" />
					<div className="flex flex-col gap-1.5">
						<h2
							id={titleId}
							className="text-xl font-medium tracking-[-0.01em] text-gray-12"
						>
							Your Loom library is ready to move
						</h2>
						<p className="max-w-md text-sm leading-relaxed text-gray-10">
							We checked every link. Upgrade to Cap Pro and we'll copy them into
							Cap for you, right where your team expects them.
						</p>
					</div>
				</div>

				<dl className="grid grid-cols-3 gap-3">
					{[
						{
							value: numberFormat.format(videoCount),
							label: videoCount === 1 ? "video" : "videos",
						},
						{ value: formatHours(totalDuration), label: "of recordings" },
						{
							value: numberFormat.format(owners),
							label: owners === 1 ? "owner" : "owners",
						},
					].map((stat) => (
						<div
							key={stat.label}
							className="flex flex-col gap-0.5 rounded-xl border border-gray-3 bg-gray-2 px-4 py-3"
						>
							<dt className="order-2 text-xs text-gray-10">{stat.label}</dt>
							<dd className="order-1 text-xl font-medium tabular-nums text-gray-12">
								{stat.value}
							</dd>
						</div>
					))}
				</dl>

				{thumbs.length > 0 && (
					<div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
						{thumbs.slice(0, 12).map((thumb, index) => (
							<div
								key={thumb}
								className={clsx(
									"li-pop aspect-video overflow-hidden rounded-md bg-gray-3",
									index >= 8 && "hidden sm:block",
								)}
								style={delay(0.05 * index)}
							>
								<img
									src={thumb}
									alt=""
									loading="lazy"
									decoding="async"
									referrerPolicy="no-referrer"
									className="size-full object-cover"
								/>
							</div>
						))}
					</div>
				)}
			</div>

			<div className="flex flex-col gap-5 border-t border-gray-3 bg-gray-2 p-6 sm:p-8 md:border-l md:border-t-0">
				<div className="flex items-center justify-between gap-3">
					<p className="text-sm font-medium text-gray-12">Cap Pro</p>
					<div className="flex rounded-full border border-gray-4 bg-gray-1 p-0.5 text-xs">
						{[
							{ value: false, label: "Monthly" },
							{ value: true, label: `Yearly · save ${ANNUAL_SAVINGS}%` },
						].map((option) => (
							<button
								key={option.label}
								type="button"
								aria-pressed={annual === option.value}
								onClick={() => setAnnual(option.value)}
								className={clsx(
									"rounded-full px-2.5 py-1 transition-colors",
									annual === option.value
										? "bg-gray-12 text-gray-1"
										: "text-gray-11 hover:text-gray-12",
								)}
							>
								{option.label}
							</button>
						))}
					</div>
				</div>

				<div className="flex items-baseline gap-1.5">
					<NumberFlow
						value={perMonth}
						className="text-3xl font-medium tabular-nums text-gray-12"
						format={{ style: "currency", currency: currency.toUpperCase() }}
					/>
					<span className="text-sm text-gray-10">
						per user / month{annual ? ", billed yearly" : ""}
					</span>
				</div>

				<ul className="flex flex-col gap-2.5">
					{PERKS.map((perk, index) => (
						<li
							key={perk}
							className="flex items-start gap-2.5 text-sm text-gray-11"
						>
							<InkCheck at={0.3 + index * 0.15} />
							{perk}
						</li>
					))}
				</ul>

				<div className="mt-auto flex flex-col gap-2">
					<Button
						type="button"
						variant="blue"
						size="md"
						className="w-full"
						spinner={checkout.isPending}
						disabled={checkout.isPending}
						onClick={() => checkout.mutate()}
					>
						Upgrade and import {numberFormat.format(videoCount)}{" "}
						{videoCount === 1 ? "video" : "videos"}
					</Button>
					<p className="text-center text-xs text-gray-10">
						Cancel anytime. Your import starts as soon as you're back.
					</p>
					<button
						type="button"
						onClick={() => setCompareOpen(true)}
						className="mx-auto text-xs text-gray-11 underline decoration-gray-6 underline-offset-4 hover:text-gray-12"
					>
						See everything in Cap Pro
					</button>
				</div>
			</div>
			<UpgradeModal open={compareOpen} onOpenChange={setCompareOpen} />
		</section>
	);
};
