import { cx } from "cva";
import { type JSX, Show } from "solid-js";
import { createOptionsQuery } from "~/utils/queries";
import { commands, type RecordingMode } from "~/utils/tauri";

interface ModeOptionProps {
	mode: RecordingMode;
	title: string;
	description: string;
	icon: (props: { class: string; style?: JSX.CSSProperties }) => JSX.Element;
	isSelected: boolean;
	onSelect: (mode: RecordingMode) => void;
}

const ModeOption = (props: ModeOptionProps) => {
	return (
		<div
			data-tauri-drag-region="none"
			onClick={() => props.onSelect(props.mode)}
			class={cx(
				"relative flex flex-col items-center rounded-xl border-2 transition-all duration-200 cursor-pointer overflow-hidden group",
				props.isSelected
					? "border-blue-9 bg-blue-3 dark:bg-blue-3/30 shadow-lg shadow-blue-9/10"
					: "border-gray-4 dark:border-gray-5 bg-gray-2 dark:bg-gray-3 hover:border-gray-6 dark:hover:border-gray-6 hover:bg-gray-3 dark:hover:bg-gray-4",
			)}
			role="button"
			aria-pressed={props.isSelected}
		>
			<Show when={props.isSelected}>
				<div class="absolute top-2.5 right-2.5 flex items-center justify-center size-5 rounded-full bg-blue-9">
					<IconLucideCheck class="size-3 text-white" />
				</div>
			</Show>

			<div class="flex items-center justify-center w-full pt-5 pb-3">
				<props.icon class="size-6 invert dark:invert-0" />
			</div>

			<div class="flex flex-col items-center px-4 pb-4 text-center">
				<h3
					class={cx(
						"text-base font-semibold mb-1.5",
						props.isSelected ? "text-blue-11" : "text-gray-12",
					)}
				>
					{props.title}
				</h3>
				<p class="text-xs leading-relaxed text-gray-11 line-clamp-3">
					{props.description}
				</p>
			</div>
		</div>
	);
};

const ModeSelect = (props: { onClose?: () => void; standalone?: boolean }) => {
	const { rawOptions, setOptions } = createOptionsQuery();

	const handleModeChange = (mode: RecordingMode) => {
		setOptions({ mode });
		commands.setRecordingMode(mode);
	};

	const modeOptions = [
		{
			mode: "instant" as const,
			title: "Instant",
			description: "Share instantly with a link. Uploads as you record.",
			icon: IconCapInstant,
		},
		{
			mode: "studio" as const,
			title: "Studio",
			description: "Highest quality local recording for editing later.",
			icon: IconCapFilmCut,
		},
		{
			mode: "screenshot" as const,
			title: "Screenshot",
			description: "Capture and annotate screenshots instantly.",
			icon: IconCapScreenshot,
		},
	];

	return (
		<div
			data-tauri-drag-region="none"
			class={cx(
				"relative",
				props.standalone
					? "absolute z-10 border border-gray-3 p-8 rounded-xl bg-gray-1"
					: "",
			)}
			onClick={(e) => e.stopPropagation()}
		>
			<Show when={props.onClose}>
				<div
					onClick={() => props.onClose?.()}
					class="absolute -top-2.5 -right-2.5 p-2 rounded-full border duration-200 bg-gray-2 border-gray-3 hover:bg-gray-3 transition-colors cursor-pointer"
				>
					<IconCapX class="invert-1 size-2 dark:invert" />
				</div>
			</Show>

			<div class="grid grid-cols-3 gap-4">
				{modeOptions.map((option) => (
					<ModeOption
						mode={option.mode}
						title={option.title}
						description={option.description}
						icon={option.icon}
						isSelected={rawOptions.mode === option.mode}
						onSelect={handleModeChange}
					/>
				))}
			</div>
		</div>
	);
};

export default ModeSelect;
