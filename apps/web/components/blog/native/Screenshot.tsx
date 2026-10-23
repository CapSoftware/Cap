import clsx from "clsx";
import Image from "next/image";
import { type RibbonKey, Stage } from "./shared";

/**
 * A real capture of a Cap window, taken with its shadow off so the page can
 * draw one that suits the panel. MDX passes every prop as a string.
 */
export function Screenshot({
	src,
	alt,
	width,
	height,
	caption,
	size = "wide",
	ribbons = "0",
}: {
	src: string;
	alt: string;
	width: string;
	height: string;
	caption?: string;
	size?: "wide" | "narrow";
	ribbons?: string;
}) {
	return (
		<Stage
			ribbons={Number(ribbons) as RibbonKey}
			caption={caption}
			className="flex justify-center"
		>
			<Image
				src={src}
				alt={alt}
				width={Number(width)}
				height={Number(height)}
				sizes={size === "wide" ? "(min-width: 1088px) 900px, 90vw" : "480px"}
				className={clsx(
					"h-auto w-full drop-shadow-[0_24px_36px_rgba(20,28,45,0.24)]",
					size === "wide" ? "max-w-[56rem]" : "max-w-[30rem]",
				)}
			/>
		</Stage>
	);
}
