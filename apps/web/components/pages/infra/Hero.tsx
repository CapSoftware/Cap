import Link from "next/link";
import {
	BODY_TEXT,
	BTN_PRIMARY,
	BTN_SECONDARY,
	H_HERO,
} from "@/components/pages/HomeTwo/theme";
import { ANCHORS, CREATE_VIDEO, CREATE_VIDEO_RESPONSE, LINKS } from "./content";
import { Code } from "./shared";

export const Hero = () => (
	<section className="px-5 pb-4 pt-14 sm:pt-16 lg:pb-6 lg:pt-24">
		<div className="mx-auto grid max-w-[1160px] items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)] lg:gap-16">
			<div className="min-w-0">
				<h1 className={`${H_HERO} text-[clamp(40px,5.2vw,64px)]`}>
					<span className="block leading-[inherit] tracking-[inherit]">
						Upload a video.
					</span>
					<span className="block leading-[inherit] tracking-[inherit]">
						Get back a stream.
					</span>
				</h1>
				<p
					className={`${BODY_TEXT} mt-7 max-w-[520px] text-pretty text-[17px] leading-[1.55] text-[rgba(17,17,17,0.76)] sm:text-[19px]`}
				>
					Cap Infra turns every upload into adaptive HLS, an MP4, a thumbnail
					and a transcript, served from a CDN. It runs on the same GPUs that
					process every Cap recording, and encoding is free.
				</p>
				<div className="mt-9 flex flex-col gap-3 min-[420px]:flex-row">
					<Link href={LINKS.start} className={BTN_PRIMARY}>
						Start building
					</Link>
					<a href={`#${ANCHORS.pricing}`} className={BTN_SECONDARY}>
						See pricing
					</a>
				</div>
			</div>
			<Code
				samples={CREATE_VIDEO}
				response={CREATE_VIDEO_RESPONSE}
				label="Create a video"
			/>
		</div>
	</section>
);
