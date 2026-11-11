"use client";

import { classNames } from "@cap/utils/helpers";
import NumberFlow from "@number-flow/react";
import { type CSSProperties, useId, useState } from "react";
import { PRICES, usd, usdWhole } from "./content";
import { GLASS_PANEL } from "./theme";

const STEPS = 1000;

type MeterKey = "stored" | "watched" | "audio";

type Meter = {
	key: MeterKey;
	label: string;
	unit: string;
	rate: string;
	min: number;
	max: number;
	initial: number;
	cost: (value: number) => number;
};

const METERS: readonly Meter[] = [
	{
		key: "stored",
		label: "Minutes stored",
		unit: "min",
		rate: `${usd(PRICES.storagePer1000Minutes)} per 1,000 minutes, per month`,
		min: 100,
		max: 10_000_000,
		initial: 5_000,
		cost: (value) => (value / 1000) * PRICES.storagePer1000Minutes,
	},
	{
		key: "watched",
		label: "Minutes watched per month",
		unit: "min",
		rate: `${usd(PRICES.deliveryPer1000Minutes)} per 1,000 minutes`,
		min: 100,
		max: 100_000_000,
		initial: 50_000,
		cost: (value) => (value / 1000) * PRICES.deliveryPer1000Minutes,
	},
	{
		key: "audio",
		label: "Hours transcribed per month",
		unit: "hr",
		rate: `${usd(PRICES.speechPerHour)} per hour of audio`,
		min: 1,
		max: 100_000,
		initial: 100,
		cost: (value) => value * PRICES.speechPerHour,
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

const SLIDER = [
	"relative block h-6 w-full cursor-pointer appearance-none bg-transparent focus-visible:outline-none",
	"[&::-webkit-slider-runnable-track]:h-[6px] [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:[background:var(--track)]",
	"[&::-webkit-slider-thumb]:-mt-[8px] [&::-webkit-slider-thumb]:size-[22px] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#F4F1EB] [&::-webkit-slider-thumb]:shadow-[0_0_0_1px_rgba(0,0,0,0.5),0_0_16px_rgba(236,232,225,0.45)] [&::-webkit-slider-thumb]:transition-[box-shadow,transform] [&::-webkit-slider-thumb]:duration-150",
	"active:[&::-webkit-slider-thumb]:scale-110 focus-visible:[&::-webkit-slider-thumb]:shadow-[0_0_0_1px_rgba(0,0,0,0.5),0_0_0_6px_rgba(236,232,225,0.22)]",
	"[&::-moz-range-track]:h-[6px] [&::-moz-range-track]:rounded-full [&::-moz-range-track]:[background:var(--track)]",
	"[&::-moz-range-thumb]:size-[22px] [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[#F4F1EB] [&::-moz-range-thumb]:shadow-[0_0_0_1px_rgba(0,0,0,0.5),0_0_16px_rgba(236,232,225,0.45)]",
	"focus-visible:[&::-moz-range-thumb]:shadow-[0_0_0_1px_rgba(0,0,0,0.5),0_0_0_6px_rgba(236,232,225,0.22)]",
].join(" ");

const MeterInput = ({
	meter,
	value,
	onChange,
}: {
	meter: Meter;
	value: number;
	onChange: (value: number) => void;
}) => {
	const id = useId();
	const [draft, setDraft] = useState<string | null>(null);
	const position = toPosition(meter, value);
	const fill = (position / STEPS) * 100;
	const trackStyle = {
		"--track": `linear-gradient(to right, rgba(236,232,225,0.35) 0%, #ECE8E1 ${fill}%, rgba(236,232,225,0.1) ${fill}%, rgba(236,232,225,0.1) 100%)`,
	} as CSSProperties;

	return (
		<div className="py-6 first:pt-0 last:pb-0">
			<div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
				<div className="min-w-0">
					<label
						htmlFor={`${id}-number`}
						className="block text-[16px] font-medium tracking-[-0.01em] text-[#ECE8E1]"
					>
						{meter.label}
					</label>
					<p className="m-0 mt-1 text-[13.5px] text-[rgba(236,232,225,0.48)]">
						{meter.rate}
					</p>
				</div>
				<div className="flex h-11 w-[168px] items-center rounded-[10px] bg-black/30 pl-3.5 pr-3 shadow-[inset_0_0_0_1px_rgba(236,232,225,0.12)] transition-shadow duration-200 focus-within:shadow-[inset_0_0_0_1px_rgba(236,232,225,0.55),0_0_0_4px_rgba(236,232,225,0.08)]">
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
						className="w-full min-w-0 bg-transparent text-right text-[16px] tabular-nums text-[#ECE8E1] outline-none"
					/>
					<span className="ml-2 shrink-0 text-[14px] text-[rgba(236,232,225,0.42)]">
						{meter.unit}
					</span>
				</div>
			</div>
			<div className="mt-5">
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
					className="relative mt-1.5 h-4 text-[12px] tabular-nums text-[rgba(236,232,225,0.34)]"
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

	const lines = METERS.map((meter) => ({
		key: meter.key,
		label: BREAKDOWN_LABEL[meter.key],
		cost: meter.cost(values[meter.key]),
	}));
	const subtotal = lines.reduce((sum, line) => sum + line.cost, 0);
	const credit = pro ? Math.min(PRICES.proMonthlyCredit, subtotal) : 0;
	const total = Math.max(0, subtotal - credit);

	return (
		<div
			className={`grid overflow-hidden rounded-[20px] ${GLASS_PANEL} lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]`}
		>
			<div className="divide-y divide-[rgba(236,232,225,0.08)] p-6 sm:p-9">
				{METERS.map((meter) => (
					<MeterInput
						key={meter.key}
						meter={meter}
						value={values[meter.key]}
						onChange={(next) =>
							setValues((current) => ({ ...current, [meter.key]: next }))
						}
					/>
				))}
			</div>
			<div className="flex flex-col border-t border-[rgba(236,232,225,0.08)] bg-black/35 p-6 text-[#ECE8E1] sm:p-9 lg:border-l lg:border-t-0">
				<p className="m-0 text-[14px] text-white/60">Your monthly estimate</p>
				<p className="m-0 mt-3 text-[clamp(44px,5.4vw,64px)] font-normal leading-none tracking-[-0.04em] tabular-nums">
					<NumberFlow value={total} format={CURRENCY} locales="en-US" />
				</p>
				<dl className="m-0 mt-8 space-y-3 text-[14.5px]">
					{lines.map((line) => (
						<div key={line.key} className="flex justify-between gap-4">
							<dt className="text-white/65">{line.label}</dt>
							<dd className="m-0 tabular-nums text-white">{usd(line.cost)}</dd>
						</div>
					))}
					<div className="flex justify-between gap-4">
						<dt className="text-white/65">Encoding</dt>
						<dd className="m-0 text-white">Free</dd>
					</div>
					<div className="flex justify-between gap-4">
						<dt className="text-white/65">Player</dt>
						<dd className="m-0 text-white">Included</dd>
					</div>
					{pro ? (
						<div className="flex justify-between gap-4">
							<dt className="text-[#D8C7A8]">Cap Pro credit</dt>
							<dd className="m-0 tabular-nums text-[#D8C7A8]">
								−{usd(credit)}
							</dd>
						</div>
					) : null}
				</dl>
				<div className="mt-auto pt-8">
					<label
						htmlFor={proId}
						className="flex cursor-pointer items-center justify-between gap-4 rounded-[14px] bg-white/[0.06] px-4 py-3.5 transition-colors duration-200 hover:bg-white/[0.09]"
					>
						<span className="text-[14.5px] leading-[1.4] text-white/85">
							I have Cap Pro
							<span className="block text-[13px] text-white/50">
								Pro includes {usdWhole(PRICES.proMonthlyCredit)} of usage every
								month
							</span>
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
									"block h-6 w-10 rounded-full transition-colors duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-white/70",
									pro ? "bg-[#ECE8E1]" : "bg-white/20",
								)}
							>
								<span
									className={classNames(
										"mt-[3px] block size-[18px] rounded-full shadow-sm transition-[transform,background-color] duration-200",
										pro
											? "translate-x-[19px] bg-[#0E0F10]"
											: "translate-x-[3px] bg-[#ECE8E1]",
									)}
								/>
							</span>
						</span>
					</label>
					<p className="m-0 mt-4 text-[13px] leading-[1.5] text-white/50">
						Prepaid credits with optional auto top-up. No minimums, no seats, no
						plans.
					</p>
				</div>
			</div>
		</div>
	);
};
