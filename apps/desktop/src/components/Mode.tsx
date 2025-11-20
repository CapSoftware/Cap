import { createSignal } from "solid-js";

import Tooltip from "~/components/Tooltip";
import { useRecordingOptions } from "~/routes/(window-chrome)/OptionsContext";
import { commands } from "~/utils/tauri";
import IconCapImageFilled from "~icons/cap/image-filled";

const Mode = () => {
	const { rawOptions, setOptions } = useRecordingOptions();
	const [isInfoHovered, setIsInfoHovered] = createSignal(false);

	return (
		<div class="flex gap-2 relative justify-end items-center p-1.5 rounded-full bg-gray-3 w-fit">
			<div
				class="absolute -left-1.5 -top-2 p-1 rounded-full w-fit bg-gray-5 group"
				onClick={() => commands.showWindow("ModeSelect")}
				onMouseEnter={() => setIsInfoHovered(true)}
				onMouseLeave={() => setIsInfoHovered(false)}
			>
				<IconCapInfo class="invert transition-opacity duration-200 cursor-pointer size-2.5 dark:invert-0 group-hover:opacity-50" />
			</div>

			{!isInfoHovered() && (
				<Tooltip
					placement="top"
					content="Instant mode"
					openDelay={0}
					closeDelay={0}
				>
					<div
						onClick={() => {
							setOptions({ mode: "instant" });
						}}
						class={`flex justify-center items-center transition-all duration-200 rounded-full size-7 hover:cursor-pointer ${
							rawOptions.mode === "instant"
								? "ring-2 ring-offset-1 ring-offset-gray-1 bg-gray-7 hover:bg-gray-7 ring-blue-500"
								: "bg-gray-3 hover:bg-gray-7"
						}`}
					>
						<IconCapInstant class="invert size-4 dark:invert-0" />
					</div>
				</Tooltip>
			)}

			{!isInfoHovered() && (
				<Tooltip
					placement="top"
					content="Studio mode"
					openDelay={0}
					closeDelay={0}
				>
					<div
						onClick={() => {
							setOptions({ mode: "studio" });
						}}
						class={`flex justify-center items-center transition-all duration-200 rounded-full size-7 hover:cursor-pointer ${
							rawOptions.mode === "studio"
								? "ring-2 ring-offset-1 ring-offset-gray-1 bg-gray-7 hover:bg-gray-7 ring-blue-500"
								: "bg-gray-3 hover:bg-gray-7"
						}`}
					>
						<IconCapFilmCut class="size-3.5 invert dark:invert-0" />
					</div>
				</Tooltip>
			)}

			{!isInfoHovered() && (
				<Tooltip
					placement="top"
					content="Screenshot mode"
					openDelay={0}
					closeDelay={0}
				>
					<div
						onClick={() => {
							setOptions({ mode: "screenshot" });
						}}
						class={`flex justify-center items-center transition-all duration-200 rounded-full size-7 hover:cursor-pointer ${
							rawOptions.mode === "screenshot"
								? "ring-2 ring-offset-1 ring-offset-gray-1 bg-gray-7 hover:bg-gray-7 ring-blue-500"
								: "bg-gray-3 hover:bg-gray-7"
						}`}
					>
						<IconCapImageFilled class="size-3.5 invert dark:invert-0" />
					</div>
				</Tooltip>
			)}

			{isInfoHovered() && (
				<>
					<div
						onClick={() => {
							setOptions({ mode: "instant" });
						}}
						class={`flex justify-center items-center transition-all duration-200 rounded-full size-7 hover:cursor-pointer ${
							rawOptions.mode === "instant"
								? "ring-2 ring-offset-1 ring-offset-gray-1 bg-gray-5 hover:bg-gray-7 ring-blue-500"
								: "bg-gray-3 hover:bg-gray-7"
						}`}
					>
						<IconCapInstant class="invert size-4 dark:invert-0" />
					</div>

					<div
						onClick={() => {
							setOptions({ mode: "studio" });
						}}
						class={`flex justify-center items-center transition-all duration-200 rounded-full size-7 hover:cursor-pointer ${
							rawOptions.mode === "studio"
								? "ring-2 ring-offset-1 ring-offset-gray-1 bg-gray-5 hover:bg-gray-7 ring-blue-10"
								: "bg-gray-3 hover:bg-gray-7"
						}`}
					>
						<IconCapFilmCut class="size-3.5 invert dark:invert-0" />
					</div>

					<div
						onClick={() => {
							setOptions({ mode: "screenshot" });
						}}
						class={`flex justify-center items-center transition-all duration-200 rounded-full size-7 hover:cursor-pointer ${
							rawOptions.mode === "screenshot"
								? "ring-2 ring-offset-1 ring-offset-gray-1 bg-gray-5 hover:bg-gray-7 ring-blue-10"
								: "bg-gray-3 hover:bg-gray-7"
						}`}
					>
						<IconCapImageFilled class="size-3.5 invert dark:invert-0" />
					</div>
				</>
			)}
		</div>
	);
};

export default Mode;
