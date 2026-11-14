"use client";

import { Input } from "@cap/ui";
import type { Folder } from "@cap/web-domain";
import clsx from "clsx";
import { Check } from "lucide-react";
import {
	FolderDoodle,
	libraryDoodleHost,
} from "../../_components/library-doodles";

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
		<fieldset className="flex gap-2 items-center min-w-0">
			<legend className="sr-only">Folder color</legend>
			{FOLDER_COLOR_OPTIONS.map((option) => {
				const selected = value === option.value;
				return (
					<button
						type="button"
						key={option.value}
						aria-label={option.label}
						aria-pressed={selected}
						title={option.label}
						disabled={disabled}
						onClick={() => onChange(option.value)}
						className={clsx(
							"flex justify-center items-center rounded-full ring-offset-2 transition-[box-shadow,transform] duration-150 size-6 ring-offset-gray-1 hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9",
							selected && "ring-2 ring-gray-12",
						)}
						style={{ backgroundColor: option.color }}
					>
						{selected && <Check className="text-white size-3.5" />}
					</button>
				);
			})}
		</fieldset>
	);
}

export function FolderDetailsFields({
	name,
	onNameChange,
	color,
	onColorChange,
	onSubmit,
	placeholder,
	disabled,
}: {
	name: string;
	onNameChange: (name: string) => void;
	color: Folder.FolderColor;
	onColorChange: (color: Folder.FolderColor) => void;
	onSubmit: () => void;
	placeholder: string;
	disabled?: boolean;
}) {
	return (
		<div
			className={clsx(
				libraryDoodleHost,
				"flex gap-4 items-center p-4 rounded-xl border border-gray-4 bg-gray-1",
			)}
		>
			<div className="flex justify-center items-center rounded-xl size-16 shrink-0 bg-gray-2">
				<FolderDoodle key={color} size={44} color={color} />
			</div>
			<div className="flex flex-col flex-1 gap-3 min-w-0">
				<Input
					autoFocus
					value={name}
					disabled={disabled}
					maxLength={255}
					onChange={(event) => onNameChange(event.target.value)}
					onKeyDown={(event) => {
						if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
						event.preventDefault();
						onSubmit();
					}}
					required
					placeholder={placeholder}
					aria-label={placeholder}
				/>
				<FolderColorPicker
					value={color}
					onChange={onColorChange}
					disabled={disabled}
				/>
			</div>
		</div>
	);
}
