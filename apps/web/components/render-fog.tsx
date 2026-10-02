import clsx from "clsx";
import "./render-fog.css";

/**
 * Drifting fog over the part of a video that isn't ready yet: on its own
 * over a blurred poster, or as an overlay that blurs the frame beneath it.
 */
export function RenderFog({
	label,
	detail,
	progress,
	poster,
	overlay = false,
	compact = false,
	className,
}: {
	label: string;
	detail?: string;
	progress?: number | null;
	poster?: string | null;
	overlay?: boolean;
	compact?: boolean;
	className?: string;
}) {
	return (
		<output
			className={clsx("render-fog", className)}
			data-overlay={overlay || undefined}
			data-compact={compact || undefined}
		>
			{poster && <img src={poster} alt="" className="render-fog-poster" />}
			<div className="render-fog-cloud is-a" />
			<div className="render-fog-cloud is-b" />
			<div className="render-fog-cloud is-c" />
			<div className="render-fog-sheen" />
			<div className="render-fog-label">
				<span>{label}</span>
				{detail && <span className="render-fog-detail">{detail}</span>}
				{progress != null && (
					<span className="render-fog-bar">
						<span
							style={{
								width: `${Math.round(Math.min(Math.max(progress, 0.03), 1) * 100)}%`,
							}}
						/>
					</span>
				)}
			</div>
		</output>
	);
}
