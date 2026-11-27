import type { AnimatedGradientConfig } from "../../../engine/types";

export function copyAnimatedGradientConfig(
	config: AnimatedGradientConfig,
): AnimatedGradientConfig {
	return {
		...config,
		colorStops: config.colorStops.map((stop) => ({
			position: stop.position,
			color: [stop.color[0], stop.color[1], stop.color[2]],
		})),
	};
}
