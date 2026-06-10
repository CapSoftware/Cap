"use client";

import { faMinus, faPlus } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import NumberFlow from "@number-flow/react";

interface StepperProps {
	label: string;
	value: number;
	onIncrement: () => void;
	onDecrement: () => void;
	decrementLabel?: string;
	incrementLabel?: string;
}

const buttonClasses =
	"flex justify-center items-center rounded-lg border shadow-sm transition-colors size-9 bg-gray-3 border-gray-5 text-gray-12 hover:bg-gray-5 hover:border-gray-6 active:bg-gray-6 disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none";

export const Stepper = ({
	label,
	value,
	onIncrement,
	onDecrement,
	decrementLabel,
	incrementLabel,
}: StepperProps) => {
	return (
		<div className="flex justify-between items-center">
			<span className="text-sm font-medium text-gray-11">{label}</span>
			<div className="flex gap-1 items-center">
				<button
					type="button"
					onClick={onDecrement}
					disabled={value <= 1}
					className={buttonClasses}
					aria-label={decrementLabel}
				>
					<FontAwesomeIcon icon={faMinus} className="size-3.5" />
				</button>
				<span className="w-10 text-base font-semibold tabular-nums text-center text-gray-12">
					<NumberFlow value={value} />
				</span>
				<button
					type="button"
					onClick={onIncrement}
					className={buttonClasses}
					aria-label={incrementLabel}
				>
					<FontAwesomeIcon icon={faPlus} className="size-3.5" />
				</button>
			</div>
		</div>
	);
};
