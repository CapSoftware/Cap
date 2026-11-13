import clsx from "clsx";
import type { ReactNode } from "react";
import { FadeIn } from "../native/shared";

const NOISE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1.1 -0.2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E")`;

/**
 * Every figure in the Cap Infra post is a plate on the night page, with the
 * same hairline, grain and Geist type as /infra, breaking out of the text
 * column like the other posts' figures.
 */
export function InfraStage({
	caption,
	children,
	className,
}: {
	caption?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<FadeIn className="relative left-1/2 my-14 w-[min(calc(100vw-2.5rem),50rem)] -translate-x-1/2 sm:my-20">
			<div className="relative isolate overflow-hidden rounded-[20px] bg-[#08080A] shadow-[inset_0_0_0_1px_rgba(222,230,246,0.09)] sm:rounded-[24px]">
				<div className={clsx("relative", className)}>{children}</div>
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 z-10 opacity-[0.055]"
					style={{ backgroundImage: NOISE, backgroundSize: "160px 160px" }}
				/>
			</div>
			{caption && (
				<figcaption className="mx-auto mt-4 max-w-[40rem] px-2 text-center text-[13.5px] leading-relaxed text-[rgba(232,236,244,0.42)]">
					{caption}
				</figcaption>
			)}
		</FadeIn>
	);
}

export const HAIRLINE = "border-[rgba(222,230,246,0.08)]";

export const MUTED = "text-[rgba(232,236,244,0.5)]";
