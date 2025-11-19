import { Button } from "@cap/ui-solid";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { remove } from "@tauri-apps/plugin-fs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import { createEffect, createSignal, Show } from "solid-js";
import Tooltip from "~/components/Tooltip";
import CaptionControlsWindows11 from "~/components/titlebar/controls/CaptionControlsWindows11";
import { commands } from "~/utils/tauri";
import IconCapTrash from "~icons/cap/trash";
import IconLucideCopy from "~icons/lucide/copy";
import IconLucideFolder from "~icons/lucide/folder";
import { useScreenshotEditorContext } from "./context";
import PresetsDropdown from "./PresetsDropdown";
import { EditorButton } from "./ui";

export function Header() {
	const { path, setDialog } = useScreenshotEditorContext();

	// Extract filename from path
	const filename = () => {
		if (!path) return "Screenshot";
		const parts = path.split(/[/\\]/);
		return parts[parts.length - 1] || "Screenshot";
	};

	return (
		<div
			data-tauri-drag-region
			class="flex relative flex-row items-center w-full h-14"
		>
			<div
				data-tauri-drag-region
				class={cx("flex flex-row flex-1 gap-2 items-center px-4 h-full")}
			>
				{ostype() === "macos" && <div class="h-full w-[4rem]" />}

				<EditorButton
					onClick={async () => {
						if (await ask("Are you sure you want to delete this screenshot?")) {
							await remove(path);
							await getCurrentWindow().close();
						}
					}}
					tooltipText="Delete screenshot"
					leftIcon={<IconCapTrash class="w-5" />}
				/>
				<EditorButton
					onClick={() => {
						revealItemInDir(path);
					}}
					tooltipText="Open containing folder"
					leftIcon={<IconLucideFolder class="w-5" />}
				/>

				<div class="flex flex-row items-center">
					<NameEditor name={filename()} />
				</div>
			</div>

			<div
				data-tauri-drag-region
				class="flex flex-col justify-center px-4 border-x border-black-transparent-10"
			>
				<PresetsDropdown />
			</div>

			<div
				data-tauri-drag-region
				class={cx(
					"flex-1 h-full flex flex-row items-center gap-2 pl-2 justify-end px-4",
					ostype() !== "windows" && "pr-2",
				)}
			>
				<EditorButton
					onClick={() => {
						commands.copyScreenshotToClipboard(path);
					}}
					tooltipText="Copy to Clipboard"
					leftIcon={<IconLucideCopy class="w-5" />}
				/>

				<Button
					variant="dark"
					class="flex gap-1.5 justify-center h-[40px] w-full max-w-[100px]"
					onClick={() => {
						setDialog({ type: "export", open: true });
					}}
				>
					<UploadIcon class="text-gray-1 size-4" />
					Export
				</Button>
				{ostype() === "windows" && <CaptionControlsWindows11 />}
			</div>
		</div>
	);
}

const UploadIcon = (props: any) => {
	return (
		<svg
			width={20}
			height={20}
			viewBox="0 0 20 20"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			{...props}
		>
			<path
				d="M16.6667 10.625V14.1667C16.6667 15.5474 15.5474 16.6667 14.1667 16.6667H5.83333C4.45262 16.6667 3.33333 15.5474 3.33333 14.1667V10.625"
				stroke="currentColor"
				stroke-width={1.66667}
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
			<path
				d="M9.99999 3.33333V12.7083M9.99999 3.33333L13.75 7.08333M9.99999 3.33333L6.24999 7.08333"
				stroke="currentColor"
				stroke-width={1.66667}
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
	);
};

function NameEditor(props: { name: string }) {
	let prettyNameRef: HTMLInputElement | undefined;
	let prettyNameMeasureRef: HTMLSpanElement | undefined;
	const [truncated, setTruncated] = createSignal(false);
	const [prettyName, setPrettyName] = createSignal(props.name);

	createEffect(() => {
		if (!prettyNameRef || !prettyNameMeasureRef) return;
		prettyNameMeasureRef.textContent = prettyName();
		const inputWidth = prettyNameRef.offsetWidth;
		const textWidth = prettyNameMeasureRef.offsetWidth;
		setTruncated(inputWidth < textWidth);
	});

	return (
		<Tooltip disabled={!truncated()} content={props.name}>
			<div class="flex relative flex-row items-center text-sm font-normal font-inherit tracking-inherit text-gray-12">
				<input
					ref={prettyNameRef}
					class={cx(
						"absolute inset-0 px-px m-0 opacity-0 overflow-hidden focus:opacity-100 bg-transparent border-b border-transparent focus:border-gray-7 focus:outline-none peer whitespace-pre",
						truncated() && "truncate",
						(prettyName().length < 1 || prettyName().length > 100) &&
							"focus:border-red-500",
					)}
					value={prettyName()}
					readOnly // Read only for now as we don't have rename logic
					onInput={(e) => setPrettyName(e.currentTarget.value)}
					onBlur={async () => {
						setPrettyName(props.name);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === "Escape") {
							prettyNameRef?.blur();
						}
					}}
				/>
				{/* Hidden span for measuring text width */}
				<span
					ref={prettyNameMeasureRef}
					class="pointer-events-none max-w-[200px] px-px m-0 peer-focus:opacity-0 border-b border-transparent truncate whitespace-pre"
				/>
			</div>
		</Tooltip>
	);
}
