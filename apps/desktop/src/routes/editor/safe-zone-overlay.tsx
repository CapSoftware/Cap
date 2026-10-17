import { Show } from "solid-js";
import { useEditorContext } from "./context";
import { SAFE_ZONE_LABELS, safeZonePlatform, safeZoneRect } from "./safe-zones";

type Size = { width: number; height: number };

export function PreviewSafeZoneOverlay(props: { size: Size }) {
	const { latestFrameLayout } = useEditorContext();
	const rect = () => {
		const platform = safeZonePlatform();
		const layout = latestFrameLayout();
		if (!platform || !layout) return null;
		const zone = safeZoneRect(
			platform,
			layout.output_width,
			layout.output_height,
		);
		return zone && { zone, label: SAFE_ZONE_LABELS[platform] };
	};
	return (
		<Show when={rect()}>
			{(current) => {
				const x = () => current().zone.x * props.size.width;
				const y = () => current().zone.y * props.size.height;
				const w = () => current().zone.w * props.size.width;
				const h = () => current().zone.h * props.size.height;
				return (
					<svg
						class="absolute inset-0 pointer-events-none"
						width={props.size.width}
						height={props.size.height}
						aria-hidden="true"
					>
						<path
							fill="rgba(239,68,68,0.22)"
							fill-rule="evenodd"
							d={`M0 0H${props.size.width}V${props.size.height}H0Z M${x()} ${y()}V${y() + h()}H${x() + w()}V${y()}Z`}
						/>
						<rect
							x={x()}
							y={y()}
							width={w()}
							height={h()}
							fill="none"
							stroke="rgba(255,255,255,0.8)"
							stroke-dasharray="6 4"
						/>
						<text
							x={x() + 6}
							y={y() + 14}
							font-size="10"
							fill="rgba(255,255,255,0.9)"
						>
							{current().label} safe zone
						</text>
					</svg>
				);
			}}
		</Show>
	);
}
