import type { CSSProperties } from "react";
import type { EmbedOptions } from "../types";
import { createEmbedUrl } from "../vanilla/cap-embed";

interface CapEmbedProps extends EmbedOptions {
	className?: string;
	style?: CSSProperties;
	width?: string | number;
	height?: string | number;
}

export function CapEmbed({
	className,
	style,
	width = "100%",
	height = "100%",
	...options
}: CapEmbedProps) {
	const src = createEmbedUrl(options);

	return (
		<iframe
			src={src}
			title="Cap video player"
			className={className}
			style={{
				border: "none",
				borderRadius: 8,
				width,
				height,
				...style,
			}}
			allow="autoplay; fullscreen; picture-in-picture"
			loading="lazy"
		/>
	);
}
