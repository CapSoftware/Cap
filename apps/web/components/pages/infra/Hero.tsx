import Link from "next/link";
import { ANCHORS, CREATE_VIDEO, CREATE_VIDEO_RESPONSE, LINKS } from "./content";
import { Plain } from "./Plain";
import { Code } from "./shared";
import { BODY, BTN_GHOST, BTN_PRIMARY, H_DISPLAY } from "./theme";

export const Hero = () => (
	<section>
		<Plain
			horizon="78%"
			slab={{
				width: "clamp(240px, 40vw, 600px)",
				height: "clamp(96px, 12vw, 180px)",
			}}
			className="h-[clamp(760px,100svh,980px)]"
		>
			<div className="relative mx-auto flex max-w-[980px] flex-col items-center px-5 pt-[112px] text-center sm:pt-[132px]">
				<h1
					className={`${H_DISPLAY} bg-[linear-gradient(180deg,#FFFFFF_0%,#ECE8E1_45%,rgba(236,232,225,0.62)_100%)] bg-clip-text text-[clamp(40px,6.4vw,84px)] text-transparent`}
				>
					<span className="block leading-[inherit] tracking-[inherit]">
						Upload a video.
					</span>
					<span className="block leading-[inherit] tracking-[inherit]">
						Get back a stream.
					</span>
				</h1>
				<p
					className={`${BODY} mt-6 max-w-[560px] text-pretty text-[16.5px] leading-[1.6] sm:text-[18px]`}
				>
					Cap Infra turns every upload into adaptive HLS, an MP4, a thumbnail
					and a transcript, served from a CDN. It runs on the same GPUs that
					process every Cap recording, and encoding is free.
				</p>
				<div className="mt-9 flex w-full flex-col gap-3 min-[420px]:w-auto min-[420px]:flex-row">
					<Link href={LINKS.start} className={BTN_PRIMARY}>
						Start building
					</Link>
					<a href={`#${ANCHORS.pricing}`} className={BTN_GHOST}>
						See pricing
					</a>
				</div>
			</div>
		</Plain>
		<div className="relative z-10 mx-auto -mt-[150px] max-w-[880px] px-4 sm:-mt-[170px] sm:px-5">
			<Code
				samples={CREATE_VIDEO}
				response={CREATE_VIDEO_RESPONSE}
				label="Create a video"
			/>
		</div>
	</section>
);
