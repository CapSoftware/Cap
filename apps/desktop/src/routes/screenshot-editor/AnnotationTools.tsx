import { cx } from "cva";
import type { Component } from "solid-js";
import Tooltip from "~/components/Tooltip";
import IconLucideArrowUpRight from "~icons/lucide/arrow-up-right";
import IconLucideCircle from "~icons/lucide/circle";
import IconLucideEyeOff from "~icons/lucide/eye-off";
import IconLucideMousePointer2 from "~icons/lucide/mouse-pointer-2";
import IconLucideSquare from "~icons/lucide/square";
import IconLucideType from "~icons/lucide/type";
import { AnnotationConfig } from "./AnnotationConfig";
import { type AnnotationType, useScreenshotEditorContext } from "./context";

export function AnnotationTools() {
	return (
		<>
			<div class="flex items-center gap-1">
				<ToolButton
					tool="select"
					icon={IconLucideMousePointer2}
					label="Select"
					shortcut="V"
				/>
				<ToolButton
					tool="arrow"
					icon={IconLucideArrowUpRight}
					label="Arrow"
					shortcut="A"
				/>
				<ToolButton
					tool="rectangle"
					icon={IconLucideSquare}
					label="Rectangle"
					shortcut="R"
				/>
				<ToolButton
					tool="mask"
					icon={IconLucideEyeOff}
					label="Mask"
					shortcut="M"
				/>
				<ToolButton
					tool="circle"
					icon={IconLucideCircle}
					label="Circle"
					shortcut="C"
				/>
				<ToolButton
					tool="text"
					icon={IconLucideType}
					label="Text"
					shortcut="T"
				/>
			</div>
			<AnnotationConfig />
		</>
	);
}

function ToolButton(props: {
	tool: AnnotationType | "select";
	icon: Component<{ class?: string }>;
	label: string;
	shortcut?: string;
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
					"flex items-center justify-center rounded-lg transition-all size-8",
					activeTool() === props.tool
						? "bg-blue-3 text-blue-11"
						: "bg-transparent hover:bg-gray-3 text-gray-11",
				)}
			>
				<props.icon class="size-4" />
			</button>
		</Tooltip>
	);
}
