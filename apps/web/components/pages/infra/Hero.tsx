import Link from "next/link";
import { LINKS } from "./content";
import { HeroArt } from "./Plain";
import styles from "./scene.module.css";
import { BODY, BTN_GHOST, BTN_PRIMARY, H_DISPLAY } from "./theme";

export const Hero = () => (
	<section className={styles.hero}>
		<HeroArt />
		<div className="mx-auto flex h-full max-w-[1184px] flex-col px-5 sm:px-8 lg:justify-center lg:pb-[16vh]">
			<div className="max-w-[520px]">
				<h1 className={`${H_DISPLAY} m-0 text-[clamp(36px,4vw,52px)]`}>
					<span className="block leading-[inherit] tracking-[inherit]">
						Upload a video.
					</span>
					<span className="block leading-[inherit] tracking-[inherit]">
						Get back a stream.
					</span>
				</h1>
				<p
					className={`${BODY} mt-5 max-w-[400px] text-pretty text-[16px] leading-[1.6]`}
				>
					Video and speech APIs on Cap's own GPUs. Every upload comes back as
					adaptive HLS up to 4K, an MP4, a thumbnail and a transcript.
				</p>
				<div className="mt-8 flex flex-wrap gap-2.5">
					<Link href={LINKS.start} className={BTN_PRIMARY}>
						Start building
					</Link>
					<Link href={LINKS.docs} className={BTN_GHOST}>
						Read the docs
					</Link>
				</div>
			</div>
		</div>
	</section>
);
