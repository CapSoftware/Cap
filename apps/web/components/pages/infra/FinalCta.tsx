import { HEADLINE_LINES, LINKS, TRUST } from "./content";
import { NightArt } from "./Plain";
import styles from "./scene.module.css";
import { Actions } from "./shared";
import { H_DISPLAY } from "./theme";

export const FinalCta = () => (
	<section className={`${styles.night} mt-24 lg:mt-32`}>
		<NightArt />
		<div className="mx-auto flex max-w-[720px] flex-col items-center px-5 pb-[300px] text-center sm:pb-[340px] lg:pb-[400px]">
			<h2 className={`${H_DISPLAY} m-0 text-[clamp(32px,4vw,48px)]`}>
				{HEADLINE_LINES[0]}{" "}
				<span className="leading-[inherit] tracking-[inherit] sm:block">
					{HEADLINE_LINES[1]}
				</span>
			</h2>
			<Actions
				className="mt-8 justify-center"
				secondary={{ label: "Read the docs", href: LINKS.docs }}
			/>
			<p className="m-0 mt-8 max-w-[440px] text-balance text-[13px] leading-[1.6] text-[rgba(232,236,244,0.42)]">
				{TRUST.join(" ")}
			</p>
		</div>
	</section>
);
