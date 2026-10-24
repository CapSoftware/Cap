"use client";

import { classNames } from "@cap/utils/helpers";
import NumberFlow from "@number-flow/react";
import { Minus, Plus } from "lucide-react";
import { MONO, type ModeTheme } from "@/components/pages/HomeTwo/theme";

type SegmentOption = {
	value: string;
	label: string;
	badge?: string;
};

export const Segmented = ({
	options,
	value,
	onChange,
	ariaLabel,
	theme,
}: {
	options: readonly [SegmentOption, SegmentOption];
	value: string;
	onChange: (value: string) => void;
	ariaLabel: string;
	theme: ModeTheme;
}) => (
	<fieldset
		aria-label={ariaLabel}
		className="m-0 grid min-w-0 grid-cols-2 gap-1 rounded-full border border-[#DDE4EB] bg-white/70 p-1"
	>
		{options.map((option) => {
			const active = option.value === value;
			return (
				<button
					key={option.value}
					type="button"
					aria-pressed={active}
					onClick={() => onChange(option.value)}
					className={classNames(
						"flex h-8 items-center justify-center gap-1.5 rounded-full px-2 text-[13px] font-medium sm:px-3 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111] focus-visible:ring-offset-1 focus-visible:ring-offset-white",
						active
							? "text-[#111111]"
							: "text-[rgba(17,17,17,0.5)] hover:bg-[#EDF1F6] hover:text-[#111111]",
					)}
					style={active ? { background: theme.chip } : undefined}
				>
					{option.label}
					{option.badge ? (
						<span
							className={`${MONO} hidden whitespace-nowrap rounded-full px-1.5 py-[3px] text-[9.5px] uppercase leading-none tracking-[0.05em] min-[360px]:inline-block`}
							style={
								active
									? { background: theme.glyph, color: "#FFFFFF" }
									: { background: theme.chip, color: theme.glyph }
							}
						>
							{option.badge}
						</span>
					) : null}
				</button>
			);
		})}
	</fieldset>
);

const STEP_BTN =
	"grid size-8 place-items-center rounded-full bg-[#EDF1F6] text-[#111111] transition-colors duration-200 hover:bg-[#DCE4EC] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-[#EDF1F6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]";

export const Stepper = ({
	label,
	value,
	onIncrement,
	onDecrement,
	decrementLabel,
	incrementLabel,
}: {
	label: string;
	value: number;
	onIncrement: () => void;
	onDecrement: () => void;
	decrementLabel: string;
	incrementLabel: string;
}) => (
	<div className="flex items-center justify-between">
		<span className="text-[14px] text-[rgba(17,17,17,0.72)]">{label}</span>
		<div className="flex items-center gap-1">
			<button
				type="button"
				onClick={onDecrement}
				disabled={value <= 1}
				className={STEP_BTN}
				aria-label={decrementLabel}
			>
				<Minus className="size-3.5" strokeWidth={2} />
			</button>
			<span className="w-9 text-center text-[15px] font-medium tabular-nums text-[#111111]">
				<NumberFlow value={value} />
			</span>
			<button
				type="button"
				onClick={onIncrement}
				className={STEP_BTN}
				aria-label={incrementLabel}
			>
				<Plus className="size-3.5" strokeWidth={2} />
			</button>
		</div>
	</div>
);
