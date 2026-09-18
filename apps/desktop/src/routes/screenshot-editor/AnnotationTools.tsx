import { cx } from "cva";
import type { Component } from "solid-js";
import Tooltip from "~/components/Tooltip";
import IconLucideArrowUpRight from "~icons/lucide/arrow-up-right";
import IconLucideCircle from "~icons/lucide/circle";
import IconLucideEyeOff from "~icons/lucide/eye-off";
import IconLucideLayers from "~icons/lucide/layers";
import IconLucideMousePointer2 from "~icons/lucide/mouse-pointer-2";
import IconLucidePencil from "~icons/lucide/pencil";
import IconLucideSquare from "~icons/lucide/square";
import IconLucideType from "~icons/lucide/type";
import {
	type ScreenshotEditorTool,
	useScreenshotEditorContext,
} from "./context";

export function AnnotationTools(props: { sidebar?: boolean }) {
	const { layersPanelOpen, setLayersPanelOpen } = useScreenshotEditorContext();

	return (
		<div
			class={cx(
				props.sidebar ? "grid grid-cols-4 gap-2" : "flex items-center gap-1",
			)}
		>
			<Tooltip content="Layers" kbd={["L"]}>
				<button
					type="button"
					onClick={() => setLayersPanelOpen(!layersPanelOpen())}
					class={cx(
						props.sidebar
							? "flex h-[68px] w-full flex-col items-center justify-center gap-2 rounded-xl border px-1 text-[11px] font-medium transition-colors"
							: "flex size-8 items-center justify-center rounded-lg transition-colors",
						layersPanelOpen()
							? props.sidebar
								? "border-ed-accent bg-ed-ctl-hover text-ed-text-1"
								: "bg-blue-3 text-blue-11"
							: props.sidebar
								? "border-transparent bg-ed-ctl text-ed-text-2 hover:border-ed-line hover:bg-ed-ctl-hover"
								: "bg-transparent hover:bg-gray-3 text-gray-11",
					)}
				>
					<IconLucideLayers class={props.sidebar ? "size-5" : "size-4"} />
					{props.sidebar && <span>Layers</span>}
				</button>
			</Tooltip>
			<div class={props.sidebar ? "hidden" : "w-px h-4 bg-gray-4 mx-1"} />
			<ToolButton
				tool="select"
				icon={IconLucideMousePointer2}
				label="Select"
				shortcut="V"
				sidebar={props.sidebar}
			/>
			<ToolButton
				tool="draw"
				icon={IconLucidePencil}
				label="Draw"
				shortcut="D"
				sidebar={props.sidebar}
			/>
			<ToolButton
				tool="arrow"
				icon={IconLucideArrowUpRight}
				label="Arrow"
				shortcut="A"
				sidebar={props.sidebar}
			/>
			<ToolButton
				tool="rectangle"
				icon={IconLucideSquare}
				label="Rectangle"
				shortcut="R"
				sidebar={props.sidebar}
			/>
			<ToolButton
				tool="mask"
				icon={IconLucideEyeOff}
				label="Mask"
				shortcut="M"
				sidebar={props.sidebar}
			/>
			<ToolButton
				tool="circle"
				icon={IconLucideCircle}
				label="Circle"
				shortcut="C"
				sidebar={props.sidebar}
			/>
			<ToolButton
				tool="text"
				icon={IconLucideType}
				label="Text"
				shortcut="T"
				sidebar={props.sidebar}
			/>
		</div>
	);
}

function ToolButton(props: {
	tool: ScreenshotEditorTool;
	icon: Component<{ class?: string }>;
	label: string;
	shortcut?: string;
	sidebar?: boolean;
}) {
	const { activeTool, setActiveTool, setSelectedAnnotationId } =
		useScreenshotEditorContext();
	return (
		<Tooltip
			content={props.label}
			kbd={props.shortcut ? [props.shortcut] : undefined}
		>
			<button
				type="button"
				onClick={() => {
					setActiveTool(props.tool);
					if (props.tool !== "select") {
						setSelectedAnnotationId(null);
					}
				}}
				class={cx(
					props.sidebar
						? "flex h-[68px] w-full flex-col items-center justify-center gap-2 rounded-xl border px-1 text-[11px] font-medium transition-colors"
						: "flex size-8 items-center justify-center rounded-lg transition-colors",
					activeTool() === props.tool
						? props.sidebar
							? "border-ed-accent bg-ed-ctl-hover text-ed-text-1"
							: "bg-blue-3 text-blue-11"
						: props.sidebar
							? "border-transparent bg-ed-ctl text-ed-text-2 hover:border-ed-line hover:bg-ed-ctl-hover"
							: "bg-transparent hover:bg-gray-3 text-gray-11",
				)}
			>
				<props.icon class={props.sidebar ? "size-5" : "size-4"} />
				{props.sidebar && <span>{props.label}</span>}
			</button>
		</Tooltip>
	);
}
