import clsx from "clsx";
import { ArrowLeftIcon, CheckIcon, type LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface DeviceSelectOption {
	value: string;
	label: string;
	icon: LucideIcon;
}

interface DeviceSelectOverlayProps {
	title: string;
	options: DeviceSelectOption[];
	selectedValue: string;
	onSelect: (value: string) => void;
	onClose: () => void;
}

/**
 * A full-panel device picker. The recorder panel renders inside a narrow,
 * fixed-size iframe, so a popper dropdown overflows it and spills off screen.
 * Instead this slides a sheet over the whole panel with a back button and a
 * scrollable list that always fits the panel bounds.
 */
export const DeviceSelectOverlay = ({
	title,
	options,
	selectedValue,
	onSelect,
	onClose,
}: DeviceSelectOverlayProps) => {
	const backRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		backRef.current?.focus();

		// Capture phase + stopImmediatePropagation so the panel's own
		// Escape-to-dismiss handler doesn't also fire and tear down the recorder
		// when the user only meant to back out of the picker.
		const handleKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopImmediatePropagation();
			onClose();
		};
		window.addEventListener("keydown", handleKey, true);
		return () => window.removeEventListener("keydown", handleKey, true);
	}, [onClose]);

	return createPortal(
		<div
			className="cap-sheet-in fixed inset-0 z-[550] flex flex-col bg-gray-2"
			role="dialog"
			aria-modal="true"
			aria-label={title}
		>
			<div className="flex h-[3rem] shrink-0 items-center gap-[0.5rem] border-b border-gray-3 bg-gray-2 px-[0.75rem]">
				<button
					ref={backRef}
					type="button"
					onClick={onClose}
					aria-label="Back"
					className="flex size-7 items-center justify-center rounded-lg text-gray-11 transition-colors hover:bg-gray-3 hover:text-[--text-primary] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-8)]"
				>
					<ArrowLeftIcon className="size-4" aria-hidden />
				</button>
				<span className="text-[0.875rem] font-medium text-[--text-primary]">
					{title}
				</span>
			</div>
			<div className="flex-1 overflow-y-auto overscroll-contain p-[0.5rem]">
				<ul className="flex flex-col gap-[0.125rem]">
					{options.map((option) => {
						const Icon = option.icon;
						const selected = option.value === selectedValue;
						return (
							<li key={option.value}>
								<button
									type="button"
									onClick={() => onSelect(option.value)}
									aria-pressed={selected}
									title={option.label}
									className={clsx(
										"flex w-full items-center gap-[0.5rem] rounded-lg px-[0.625rem] py-[0.5rem] text-left text-[0.875rem] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-8)]",
										selected
											? "bg-[var(--blue-3)] text-[var(--blue-11)]"
											: "text-[--text-primary] hover:bg-gray-3",
									)}
								>
									<Icon
										className={clsx(
											"size-4 shrink-0",
											selected ? "text-[var(--blue-11)]" : "text-gray-11",
										)}
										aria-hidden
									/>
									<span className="flex-1 truncate">{option.label}</span>
									{selected && (
										<CheckIcon
											className="size-4 shrink-0 text-[var(--blue-11)]"
											aria-hidden
										/>
									)}
								</button>
							</li>
						);
					})}
				</ul>
			</div>
		</div>,
		document.body,
	);
};
