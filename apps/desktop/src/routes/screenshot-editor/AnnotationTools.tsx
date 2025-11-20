import { cx } from "cva";
import { Show } from "solid-js";
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
				/>
				<ToolButton tool="arrow" icon={IconLucideArrowUpRight} label="Arrow" />
				<ToolButton
					tool="rectangle"
					icon={IconLucideSquare}
					label="Rectangle"
				/>
				<ToolButton tool="mask" icon={IconLucideEyeOff} label="Mask" />
				<ToolButton tool="circle" icon={IconLucideCircle} label="Circle" />
				<ToolButton tool="text" icon={IconLucideType} label="Text" />
			</div>
			<AnnotationConfig />
		</>
	);
}

import type { Component } from "solid-js";

function ToolButton(props: {
	tool: AnnotationType | "select";
	icon: Component<{ class?: string }>;
	label: string;
}) {
	const { activeTool, setActiveTool, setSelectedAnnotationId } =
		useScreenshotEditorContext();
	return (
		<button
			type="button"
			onClick={() => {
				setActiveTool(props.tool);
				if (props.tool !== "select") {
					setSelectedAnnotationId(null);
				}
			}}
			class={cx(
				"flex items-center justify-center rounded-[0.5rem] transition-all size-8",
				activeTool() === props.tool
					? "bg-blue-3 text-blue-11"
					: "bg-transparent hover:bg-gray-3 text-gray-11",
			)}
			title={props.label}
		>
			<props.icon class="size-4" />
		</button>
	);
}
