"use client";

import { classNames } from "@cap/utils";

interface BillingToggleOption {
	value: string;
	label: string;
	badge?: string;
}

interface BillingToggleProps {
	options: readonly [BillingToggleOption, BillingToggleOption];
	value: string;
	onChange: (value: string) => void;
	ariaLabel?: string;
}

export const BillingToggle = ({
	options,
	value,
	onChange,
	ariaLabel,
}: BillingToggleProps) => {
	const activeIndex = Math.max(
		0,
		options.findIndex((option) => option.value === value),
	);

	return (
		<fieldset
			aria-label={ariaLabel}
			className="grid relative grid-cols-2 p-1 m-0 rounded-lg border-0 bg-gray-3"
		>
			<div
				aria-hidden
				className="absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-md border shadow-sm transition-transform duration-300 ease-out bg-gray-1 border-gray-4"
				style={{
					transform: activeIndex === 1 ? "translateX(100%)" : "translateX(0%)",
				}}
			/>
			{options.map((option) => {
				const isActive = option.value === value;
				return (
					<button
						key={option.value}
						type="button"
						aria-pressed={isActive}
						onClick={() => onChange(option.value)}
						className={classNames(
							"flex relative z-10 gap-1.5 justify-center items-center px-3 h-8 text-sm font-medium rounded-md transition-colors",
							isActive ? "text-gray-12" : "text-gray-10 hover:text-gray-12",
						)}
					>
						{option.label}
						{option.badge ? (
							<span
								className={classNames(
									"px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded-full transition-colors",
									isActive
										? "text-white bg-blue-500"
										: "text-blue-600 bg-blue-500/10",
								)}
							>
								{option.badge}
							</span>
						) : null}
					</button>
				);
			})}
		</fieldset>
	);
};
