import { getCurrentWindow } from "@tauri-apps/api/window";
import { cx } from "cva";
import {
	type ComponentProps,
	createSignal,
	onCleanup,
	onMount,
	Show,
	splitProps,
} from "solid-js";

export default function CaptionControlsMacOS(
	props: ComponentProps<"div"> & { showMinimize?: boolean; showZoom?: boolean },
) {
	const [local, otherProps] = splitProps(props, [
		"class",
		"showMinimize",
		"showZoom",
	]);
	const currentWindow = getCurrentWindow();
	const [focused, setFocus] = createSignal(true);
	const [hovered, setHovered] = createSignal(false);

	let unlisten: (() => void) | undefined;
	onMount(async () => {
		unlisten = await currentWindow.onFocusChanged(({ payload: focused }) =>
			setFocus(focused),
		);
	});
	onCleanup(() => unlisten?.());

	const showMinimize = () => local.showMinimize ?? true;
	const showZoom = () => local.showZoom ?? true;

	const handleClose = async () => {
		currentWindow.close();
	};

	return (
		<div
			class={cx(
				"flex flex-row items-center gap-2 h-full cursor-default select-none",
				local.class,
			)}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			{...otherProps}
		>
			<TrafficLightButton
				type="close"
				focused={focused()}
				hovered={hovered()}
				onClick={handleClose}
			/>
			<Show when={showMinimize()}>
				<TrafficLightButton
					type="minimize"
					focused={focused()}
					hovered={hovered()}
					onClick={() => currentWindow.minimize()}
				/>
			</Show>
			<Show when={showZoom()}>
				<TrafficLightButton
					type="zoom"
					focused={focused()}
					hovered={hovered()}
					onClick={() => currentWindow.toggleMaximize()}
				/>
			</Show>
		</div>
	);
}

interface TrafficLightButtonProps {
	type: "close" | "minimize" | "zoom";
	focused: boolean;
	hovered: boolean;
	onClick: () => void;
}

function TrafficLightButton(props: TrafficLightButtonProps) {
	const colors = {
		close: {
			bg: "#FF5F57",
			bgHover: "#FF5F57",
			iconColor: "#4D0000",
		},
		minimize: {
			bg: "#FEBC2E",
			bgHover: "#FEBC2E",
			iconColor: "#995700",
		},
		zoom: {
			bg: "#28C840",
			bgHover: "#28C840",
			iconColor: "#006500",
		},
	};

	const color = () => colors[props.type];

	return (
		<button
			type="button"
			class={cx(
				"w-3 h-3 rounded-full flex items-center justify-center transition-colors duration-100",
				"hover:brightness-95 active:brightness-90",
			)}
			style={{
				"background-color": props.focused ? color().bg : "#DCDCDC",
			}}
			onClick={(e) => {
				e.stopPropagation();
				props.onClick();
			}}
		>
			<Show when={props.hovered && props.focused}>
				<TrafficLightIcon type={props.type} color={color().iconColor} />
			</Show>
		</button>
	);
}

interface TrafficLightIconProps {
	type: "close" | "minimize" | "zoom";
	color: string;
}

function TrafficLightIcon(props: TrafficLightIconProps) {
	return (
		<svg
			width="8"
			height="8"
			viewBox="0 0 8 8"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
		>
			{props.type === "close" && (
				<path
					d="M1.182 1.182a.625.625 0 0 1 .884 0L4 3.116l1.934-1.934a.625.625 0 1 1 .884.884L4.884 4l1.934 1.934a.625.625 0 1 1-.884.884L4 4.884 2.066 6.818a.625.625 0 1 1-.884-.884L3.116 4 1.182 2.066a.625.625 0 0 1 0-.884Z"
					fill={props.color}
				/>
			)}
			{props.type === "minimize" && (
				<path
					d="M1 4a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5A.5.5 0 0 1 1 4Z"
					fill={props.color}
				/>
			)}
			{props.type === "zoom" && (
				<path
					d="M1.5 1.5a.5.5 0 0 1 .5-.5h4.5a.5.5 0 0 1 .5.5V6a.5.5 0 0 1-.5.5H2a.5.5 0 0 1-.5-.5V1.5Zm1 .5v3.5h3.5V2H2.5Z"
					fill={props.color}
				/>
			)}
		</svg>
	);
}
