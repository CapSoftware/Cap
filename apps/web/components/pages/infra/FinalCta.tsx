import Link from "next/link";
import { LINKS, TRUST } from "./content";
import { NightArt } from "./Plain";
import styles from "./scene.module.css";
import { BTN_GHOST, BTN_PRIMARY, H_DISPLAY } from "./theme";

export const FinalCta = () => (
	<section className={`${styles.night} mt-28 lg:mt-40`}>
		<NightArt />
		<div className="mx-auto flex max-w-[720px] flex-col items-center px-5 pb-[300px] text-center sm:pb-[340px] lg:pb-[400px]">
			<h2 className={`${H_DISPLAY} m-0 text-[clamp(32px,4vw,48px)]`}>
				The cheapest, fastest{" "}
				<span className="leading-[inherit] tracking-[inherit] sm:block">
					video infrastructure.
				</span>
			</h2>
			<div className="mt-8 flex flex-wrap justify-center gap-2.5">
				<Link href={LINKS.start} className={BTN_PRIMARY}>
					Start building
				</Link>
				<Link href={LINKS.docs} className={BTN_GHOST}>
					Read the docs
				</Link>
			</div>
			<p className="m-0 mt-8 max-w-[440px] text-balance text-[13px] leading-[1.6] text-[rgba(232,236,244,0.42)]">
				{TRUST.join(" ")}
			</p>
		</div>
	</section>
);
