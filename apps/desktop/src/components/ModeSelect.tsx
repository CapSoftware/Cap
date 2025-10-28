import { cx } from "cva";
import { type JSX, Show } from "solid-js";
import { createOptionsQuery } from "~/utils/queries";
import type { RecordingMode } from "~/utils/tauri";

interface ModeOptionProps {
	mode: RecordingMode;
	title: string;
	description: string;
	standalone?: boolean;
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
				"p-5 space-y-3 rounded-lg border transition-all duration-200 cursor-pointer h-fit",
				props.isSelected
					? "border-blue-7 bg-blue-3/60 dark:border-blue-6 dark:bg-blue-4/40"
					: "border-gray-4 dark:border-gray-3 dark:bg-gray-2 hover:border-gray-6 dark:hover:border-gray-4 hover:bg-gray-2 dark:hover:bg-gray-3",
			)}
			role="button"
			aria-pressed={props.isSelected}
		>
			<div class="flex flex-col items-center mb-2 text-center">
				{props.icon({
					class: "size-12 mb-5 invert dark:invert-0",
				})}
				<h3 class="text-lg font-medium text-gray-12">{props.title}</h3>
			</div>

			<p
				class={cx(
					"mx-auto w-full text-sm max-w-[300px]",
					props.isSelected ? "text-gray-12" : "text-gray-11",
				)}
			>
				{props.description}
			</p>
		</div>
	);
};

const ModeSelect = (props: { onClose?: () => void; standalone?: boolean }) => {
	const { rawOptions, setOptions } = createOptionsQuery();

	const handleModeChange = (mode: RecordingMode) => {
		setOptions({ mode });
	};

	const modeOptions = [
		{
			mode: "instant" as const,
			title: "Instant Mode",
			description:
				"Share your screen instantly with a shareable link. No waiting for rendering, just capture and share. Uploads in the background as you record.",
			icon: IconCapInstant,
		},
		{
			mode: "studio" as const,
			title: "Studio Mode",
			description:
				"Records at the highest quality and framerate, completely locally. Captures both your screen and camera separately for editing and exporting later.",
			icon: IconCapFilmCut,
		},
	];

	return (
		<div
			data-tauri-drag-region="none"
			class={cx(
				"grid grid-cols-2 gap-8 items-center text-center bg-gray-1",
				props.standalone
					? "absolute z-10 border border-gray-3 p-16 rounded-xl"
					: "",
			)}
			onClick={(e) => e.stopPropagation()}
		>
			<Show when={props.onClose}>
				<div
					onClick={() => props.onClose?.()}
					class="absolute -top-2.5 -right-2.5 p-2 rounded-full border duration-200 bg-gray-2 border-gray-3 hover:bg-gray-3 transition-duration"
				>
					<IconCapX class="invert-1 size-2 dark:invert" />
				</div>
			</Show>
			{props.standalone && (
				<h2 class="text-[24px] col-span-2 font-medium text-center text-gray-12">
					Recording Modes
				</h2>
			)}
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
	);
};

export default ModeSelect;
