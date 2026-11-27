import clsx from "clsx";
import { formatDuration } from "@/components/VideoThumbnail";

export function NoteThumbnail({
	excerpt,
	duration,
	dimmed,
	controlsShown,
}: {
	excerpt?: string | null;
	duration?: number | null;
	dimmed?: boolean;
	controlsShown?: boolean;
}) {
	return (
		<div
			className={clsx(
				"overflow-hidden absolute inset-0 rounded-t-xl border-b transition-opacity duration-300 bg-gray-2 border-gray-3",
				dimmed && "opacity-60",
			)}
		>
			<p className="overflow-hidden absolute inset-x-4 top-3.5 bottom-9 text-sm leading-[1.5] tracking-[-0.005em] text-gray-12 [overflow-wrap:anywhere] [mask-image:linear-gradient(to_bottom,black_45%,transparent_96%)]">
				{excerpt}
			</p>
			<div
				aria-hidden
				className={clsx(
					"absolute inset-x-0 top-0 h-16 bg-gradient-to-b to-transparent transition-opacity duration-200 pointer-events-none from-gray-2 from-50%",
					controlsShown ? "opacity-100" : "opacity-0 group-hover:opacity-100",
				)}
			/>
			{duration ? (
				<p className="absolute bottom-2.5 left-2.5 z-10 px-1.5 py-[3px] text-[11px] font-medium tabular-nums leading-none text-white rounded-md backdrop-blur-sm bg-black/60">
					{formatDuration(duration)}
				</p>
			) : null}
		</div>
	);
}
