"use client";

import { classNames } from "@cap/utils/helpers";
import NumberFlow from "@number-flow/react";
import Link from "next/link";
import { type CSSProperties, useId, useState } from "react";
import type { InfraResolutionTier } from "@/lib/infra-pricing";
import { LINKS, PRICES, usd, usdWhole } from "./content";
import { TierSwitch, useTier } from "./TierSwitch";
import { BTN_PRIMARY, H_SECTION, MONO } from "./theme";

const STEPS = 1000;

type MeterKey = "stored" | "watched" | "audio";

type Meter = {
	key: MeterKey;
	label: string;
	unit: string;
	min: number;
	max: number;
	initial: number;
	rate: (tier: InfraResolutionTier) => number;
	per: number;
	rateUnit: string;
};

const METERS: readonly Meter[] = [
	{
		key: "stored",
		label: "Minutes stored",
		unit: "min",
		min: 100,
		max: 10_000_000,
		initial: 5_000,
		rate: (tier) => PRICES.storagePer1000Minutes[tier],
		per: 1000,
		rateUnit: "per 1,000 minutes, per month",
	},
	{
		key: "watched",
		label: "Minutes watched per month",
		unit: "min",
		min: 100,
		max: 100_000_000,
		initial: 50_000,
		rate: (tier) => PRICES.deliveryPer1000Minutes[tier],
		per: 1000,
		rateUnit: "per 1,000 minutes",
	},
	{
		key: "audio",
		label: "Hours transcribed per month",
		unit: "hr",
		min: 1,
		max: 100_000,
		initial: 100,
		rate: () => PRICES.speechPerHour,
		per: 1,
		rateUnit: "per hour of audio",
	},
];

const BREAKDOWN_LABEL: Record<MeterKey, string> = {
	stored: "Storage",
	watched: "Delivery",
	audio: "Speech to text",
};

const roundNice = (value: number) => {
	if (value < 10) return Math.round(value);
	const magnitude = 10 ** (Math.floor(Math.log10(value)) - 1);
	return Math.round(value / magnitude) * magnitude;
};

const toValue = (meter: Meter, position: number) => {
	if (position <= 0) return 0;
	const lo = Math.log10(meter.min);
	const hi = Math.log10(meter.max);
	return Math.min(
		meter.max,
		roundNice(10 ** (lo + (position / STEPS) * (hi - lo))),
	);
};

const toPosition = (meter: Meter, value: number) => {
	if (value <= 0) return 0;
	if (value <= meter.min) return 1;
	const lo = Math.log10(meter.min);
	const hi = Math.log10(meter.max);
	const position = ((Math.log10(value) - lo) / (hi - lo)) * STEPS;
	return Math.min(STEPS, Math.max(1, Math.round(position)));
};

const ticksFor = (meter: Meter) => {
	const ticks: number[] = [];
	for (
		let value = meter.min * 10;
		value <= meter.max;
		value *= meter.max / meter.min > 1_000_000 ? 100 : 10
	) {
		ticks.push(value);
	}
	return ticks;
};

const compact = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
});

const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const CURRENCY = {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
} as const;

const BREAKDOWN_ROW =
	"flex items-baseline justify-between gap-4 border-b border-[rgba(222,230,246,0.07)] py-2.5 first:border-t";

const BREAKDOWN_FIGURE = `${MONO} m-0 text-[13px] tabular-nums text-[rgba(232,236,244,0.9)]`;

const SLIDER = [
	"relative block h-5 w-full cursor-pointer appearance-none bg-transparent focus-visible:outline-none",
	"[&::-webkit-slider-runnable-track]:h-[2px] [&::-webkit-slider-runnable-track]:[background:var(--track)]",
	"[&::-webkit-slider-thumb]:-mt-[6px] [&::-webkit-slider-thumb]:size-[14px] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-[0_0_0_4px_#050506,0_0_14px_2px_rgba(200,216,255,0.5)] [&::-webkit-slider-thumb]:transition-shadow [&::-webkit-slider-thumb]:duration-150",
	"focus-visible:[&::-webkit-slider-thumb]:shadow-[0_0_0_4px_#050506,0_0_0_6px_rgba(232,236,244,0.5)]",
	"[&::-moz-range-track]:h-[2px] [&::-moz-range-track]:[background:var(--track)]",
	"[&::-moz-range-thumb]:size-[14px] [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:shadow-[0_0_0_4px_#050506,0_0_14px_2px_rgba(200,216,255,0.5)]",
	"focus-visible:[&::-moz-range-thumb]:shadow-[0_0_0_4px_#050506,0_0_0_6px_rgba(232,236,244,0.5)]",
].join(" ");

const MeterInput = ({
	meter,
	tier,
	value,
	onChange,
}: {
	meter: Meter;
	tier: InfraResolutionTier;
	value: number;
	onChange: (value: number) => void;
}) => {
	const id = useId();
	const [draft, setDraft] = useState<string | null>(null);
	const position = toPosition(meter, value);
	const fill = (position / STEPS) * 100;
	const trackStyle = {
		"--track": `linear-gradient(to right, rgba(232,236,244,0.9) 0%, rgba(232,236,244,0.9) ${fill}%, rgba(222,230,246,0.14) ${fill}%, rgba(222,230,246,0.14) 100%)`,
	} as CSSProperties;

	return (
		<div className="py-5 last:pb-0">
			<div className="flex items-start justify-between gap-x-4">
				<div className="min-w-0 flex-1">
					<label
						htmlFor={`${id}-number`}
						className="block text-[14.5px] text-[#E8ECF4]"
					>
						{meter.label}
					</label>
					<p className="m-0 mt-0.5 text-[13px] text-[rgba(232,236,244,0.42)]">
						{usd(meter.rate(tier))} {meter.rateUnit}
					</p>
				</div>
				<div className="flex shrink-0 items-baseline border-b border-[rgba(222,230,246,0.16)] pb-1 transition-colors duration-200 focus-within:border-[rgba(232,236,244,0.7)]">
					<input
						id={`${id}-number`}
						type="text"
						inputMode="numeric"
						autoComplete="off"
						value={draft ?? grouped.format(value)}
						onFocus={(event) => {
							setDraft(String(value));
							event.currentTarget.select();
						}}
						onBlur={() => setDraft(null)}
						onChange={(event) => {
							const digits = event.target.value.replace(/\D/g, "");
							setDraft(digits);
							const next = digits === "" ? 0 : Number(digits);
							onChange(Math.min(meter.max, next));
						}}
						className="w-[92px] min-w-0 bg-transparent text-right text-[16px] tabular-nums text-[#E8ECF4] outline-none"
					/>
					<span className="ml-1.5 w-7 shrink-0 text-[13px] text-[rgba(232,236,244,0.42)]">
						{meter.unit}
					</span>
				</div>
			</div>
			<div className="mt-3">
				<input
					type="range"
					min={0}
					max={STEPS}
					step={1}
					value={position}
					aria-label={meter.label}
					aria-valuetext={`${grouped.format(value)} ${meter.unit === "hr" ? "hours" : "minutes"}`}
					onChange={(event) =>
						onChange(toValue(meter, Number(event.target.value)))
					}
					className={SLIDER}
					style={trackStyle}
				/>
				<div
					aria-hidden="true"
					className="relative mt-0.5 h-4 text-[11.5px] tabular-nums text-[rgba(232,236,244,0.3)]"
				>
					<span className="absolute left-0">0</span>
					{ticksFor(meter).map((tick, i, all) => {
						const left = (toPosition(meter, tick) / STEPS) * 100;
						return (
							<span
								key={tick}
								className={classNames(
									"absolute",
									left >= 99 ? "right-0" : "-translate-x-1/2",
									(all.length - 1 - i) % 2 === 1 && "hidden sm:block",
								)}
								style={left >= 99 ? undefined : { left: `${left}%` }}
							>
								{compact.format(tick)}
							</span>
						);
					})}
				</div>
			</div>
		</div>
	);
};

export const Calculator = () => {
	const [values, setValues] = useState<Record<MeterKey, number>>(() => ({
		stored: METERS[0]?.initial ?? 0,
		watched: METERS[1]?.initial ?? 0,
		audio: METERS[2]?.initial ?? 0,
	}));
	const [pro, setPro] = useState(false);
	const proId = useId();
	const tier = useTier();

	const lines = METERS.map((meter) => ({
		key: meter.key,
		label: BREAKDOWN_LABEL[meter.key],
		cost: (values[meter.key] / meter.per) * meter.rate(tier),
	}));
	const subtotal = lines.reduce((sum, line) => sum + line.cost, 0);
	const credit = pro ? Math.min(PRICES.proMonthlyCredit, subtotal) : 0;
	const total = Math.max(0, subtotal - credit);

	return (
		<div className="grid gap-x-16 gap-y-8 border-t border-[rgba(222,230,246,0.08)] pt-10 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:gap-y-7 lg:pt-12">
			<h3 className={`${H_SECTION} m-0 text-[22px]`}>Estimate your bill.</h3>
			<div className="min-w-0 divide-y divide-[rgba(222,230,246,0.07)] lg:col-start-2 lg:row-span-2 lg:row-start-1">
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 pb-5">
					<div className="min-w-0">
						<p className="m-0 text-[14.5px] text-[#E8ECF4]">Resolution</p>
						<p className="m-0 mt-0.5 text-[13px] text-[rgba(232,236,244,0.42)]">
							Sets the storage and delivery rates
						</p>
					</div>
					<TierSwitch label="Resolution to estimate" />
				</div>
				{METERS.map((meter) => (
					<MeterInput
						key={meter.key}
						meter={meter}
						tier={tier}
						value={values[meter.key]}
						onChange={(next) =>
							setValues((current) => ({ ...current, [meter.key]: next }))
						}
					/>
				))}
			</div>
			<div className="flex min-w-0 flex-col text-[#E8ECF4] lg:col-start-1 lg:row-start-2">
				<p className="m-0 text-[13.5px] text-[rgba(232,236,244,0.5)]">
					Estimated month
				</p>
				<p
					className={`${MONO} m-0 mt-2.5 text-[38px] leading-none tracking-[-0.045em] tabular-nums text-white`}
				>
					<NumberFlow value={total} format={CURRENCY} locales="en-US" />
				</p>
				<dl className="m-0 mt-7 text-[13.5px]">
					{lines.map((line) => (
						<div key={line.key} className={BREAKDOWN_ROW}>
							<dt className="text-[rgba(232,236,244,0.5)]">{line.label}</dt>
							<dd className={BREAKDOWN_FIGURE}>{usd(line.cost)}</dd>
						</div>
					))}
					<div className={BREAKDOWN_ROW}>
						<dt className="text-[rgba(232,236,244,0.5)]">Encoding</dt>
						<dd className={BREAKDOWN_FIGURE}>Free</dd>
					</div>
					{pro ? (
						<div className={BREAKDOWN_ROW}>
							<dt className="text-[rgba(232,236,244,0.5)]">Cap Pro credit</dt>
							<dd className={BREAKDOWN_FIGURE}>−{usd(credit)}</dd>
						</div>
					) : null}
				</dl>
				<label
					htmlFor={proId}
					className="flex cursor-pointer items-center justify-between gap-4 py-3.5 text-[13.5px] text-[rgba(232,236,244,0.7)] transition-colors duration-200 hover:text-[#E8ECF4]"
				>
					<span>
						I have Cap Pro, with {usdWhole(PRICES.proMonthlyCredit)} of usage
						included
					</span>
					<span className="relative inline-flex shrink-0">
						<input
							id={proId}
							type="checkbox"
							role="switch"
							aria-checked={pro}
							checked={pro}
							onChange={(event) => setPro(event.target.checked)}
							className="peer absolute inset-0 z-10 m-0 cursor-pointer appearance-none rounded-full opacity-0"
						/>
						<span
							aria-hidden="true"
							className={classNames(
								"block h-[18px] w-8 rounded-full transition-colors duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-[rgba(232,236,244,0.7)]",
								pro ? "bg-[#E8ECF4]" : "bg-[rgba(222,230,246,0.18)]",
							)}
						>
							<span
								className={classNames(
									"mt-[3px] block size-3 rounded-full transition-[transform,background-color] duration-200",
									pro
										? "translate-x-[17px] bg-[#050506]"
										: "translate-x-[3px] bg-[#E8ECF4]",
								)}
							/>
						</span>
					</span>
				</label>
				<Link href={LINKS.start} className={`${BTN_PRIMARY} mt-4 self-start`}>
					Start building
				</Link>
			</div>
		</div>
	);
};
