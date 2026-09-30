import type { Component, ComponentProps } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { InfoPillVariant } from "./InfoPill";

export default function TargetSelectInfoPill<T>(props: {
	value: T | null;
	permissionGranted: boolean;
	disconnected?: boolean;
	requestPermission: () => void;
	onClick: (e: MouseEvent) => void;
	PillComponent: Component<
		ComponentProps<"button"> & { variant: InfoPillVariant }
	>;
}) {
	const variant = (): InfoPillVariant => {
		if (!props.permissionGranted) return "red";
		if (props.disconnected) return "gray";
		return props.value !== null ? "blue" : "gray";
	};

	return (
		<Dynamic
			component={props.PillComponent}
			variant={variant()}
			onPointerDown={(e) => {
				if (!props.permissionGranted || props.value === null) return;

				e.stopPropagation();
			}}
			onClick={(e) => {
				if (!props.permissionGranted) {
					e.stopPropagation();
					props.requestPermission();
					return;
				}

				props.onClick(e);
			}}
		>
			{!props.permissionGranted
				? "Allow"
				: props.disconnected
					? "Not connected"
					: props.value !== null
						? "On"
						: "Off"}
		</Dynamic>
	);
}
