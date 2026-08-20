"use client";

import clsx from "clsx";
import { Check, ChevronDown } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

export type SelectOption<T> = {
	label: string;
	value: T;
	separatorBefore?: boolean;
};

export const ProChip = () => (
	<span className="py-1 px-1.5 text-[10px] font-medium leading-none text-white rounded-full bg-blue-11">
		Pro
	</span>
);

export function SettingSelect<T extends string | number | boolean>({
	value,
	options: selectOptions,
	onChange,
	ariaLabel,
	onInterceptOpen,
}: {
	value: T;
	options: SelectOption<T>[];
	onChange: (value: T) => void;
	ariaLabel: string;
	onInterceptOpen?: () => void;
}) {
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;

		const handleClickOutside = (event: MouseEvent) => {
			if (
				containerRef.current &&
				!containerRef.current.contains(event.target as Node)
			) {
				setOpen(false);
			}
		};

		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [open]);

	const selected = selectOptions.find((option) => option.value === value);

	return (
		<div className="relative" ref={containerRef}>
			<button
				type="button"
				aria-label={ariaLabel}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => {
					if (onInterceptOpen) {
						onInterceptOpen();
						return;
					}

					setOpen((isOpen) => !isOpen);
				}}
				className="flex gap-1.5 items-center px-3 h-8 rounded-full border transition-colors border-gray-4 bg-gray-1 hover:bg-gray-2 text-[13px] text-gray-12 shadow-xs"
			>
				<span className="whitespace-nowrap">{selected?.label}</span>
				<ChevronDown className="w-3.5 h-3.5 shrink-0 text-gray-9" />
			</button>
			{open && (
				<div className="overflow-y-auto absolute right-0 top-full z-50 p-1 mt-1.5 w-max rounded-xl border shadow-lg min-w-44 max-h-64 bg-gray-1 border-gray-3">
					{selectOptions.map((option) => (
						<div key={String(option.value)}>
							{option.separatorBefore && (
								<div className="my-1 -mx-1 border-t border-gray-3" />
							)}
							<button
								type="button"
								onClick={() => {
									setOpen(false);
									onChange(option.value);
								}}
								className={clsx(
									"flex gap-3 justify-between items-center px-2.5 py-1.5 w-full text-left rounded-lg transition-colors text-[13px] text-gray-12",
									option.value === value ? "bg-gray-3" : "hover:bg-gray-2",
								)}
							>
								<span className="whitespace-nowrap">{option.label}</span>
								{option.value === value && (
									<Check className="w-3.5 h-3.5 shrink-0 text-gray-12" />
								)}
							</button>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

export const SettingRow = ({
	label,
	description,
	pro,
	control,
}: {
	label: string;
	description: string;
	pro?: boolean;
	control: ReactNode;
}) => (
	<div className="flex flex-col gap-2 items-start py-3.5 px-4 sm:flex-row sm:gap-6 sm:justify-between sm:items-center">
		<div className="flex flex-col gap-0.5">
			<div className="flex gap-1.5 items-center">
				<p className="text-sm font-medium text-gray-12">{label}</p>
				{pro && <ProChip />}
			</div>
			<p className="max-w-md text-[13px] text-gray-10">{description}</p>
		</div>
		<div className="shrink-0">{control}</div>
	</div>
);
