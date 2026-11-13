"use client";

import type { Folder } from "@cap/web-domain";
import { faFolder } from "@fortawesome/free-solid-svg-icons/faFolder";
import clsx from "clsx";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";

export const DEFAULT_FOLDER_COLOR: Folder.FolderColor = "normal";

const FOLDER_COLOR_OPTIONS: {
	value: Folder.FolderColor;
	label: string;
	color: string;
}[] = [
	{ value: "normal", label: "Default", color: "#9ca3af" },
	{ value: "blue", label: "Blue", color: "#3b82f6" },
	{ value: "red", label: "Red", color: "#ef4444" },
	{ value: "yellow", label: "Yellow", color: "#eab308" },
];

export function FolderColorPicker({
	value,
	onChange,
	disabled,
}: {
	value: Folder.FolderColor;
	onChange: (color: Folder.FolderColor) => void;
	disabled?: boolean;
}) {
	return (
		<fieldset className="grid grid-cols-4 gap-2 min-w-0">
			<legend className="sr-only">Folder color</legend>
			{FOLDER_COLOR_OPTIONS.map((option) => {
				const selected = value === option.value;
				return (
					<button
						type="button"
						key={option.value}
						aria-pressed={selected}
						disabled={disabled}
						onClick={() => onChange(option.value)}
						className={clsx(
							"flex gap-2 justify-center items-center px-2 h-10 min-w-0 text-[13px] rounded-lg border transition-colors",
							selected
								? "font-medium border-gray-12 bg-gray-3 text-gray-12"
								: "border-gray-4 text-gray-11 hover:border-gray-6 hover:bg-gray-3",
						)}
					>
						<FontAwesomeIcon
							icon={faFolder}
							className="shrink-0 size-4"
							style={{ color: option.color }}
						/>
						<span className="truncate">{option.label}</span>
					</button>
				);
			})}
		</fieldset>
	);
}
