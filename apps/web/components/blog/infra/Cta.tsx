import Link from "next/link";
import {
	HEADLINE_LINES,
	LINKS,
	PREVIEW_NOTE,
	START,
	TRUST,
} from "@/components/pages/infra/content";
import { NightArt } from "@/components/pages/infra/Plain";
import styles from "@/components/pages/infra/scene.module.css";
import {
	BTN_GHOST,
	BTN_PRIMARY,
	H_DISPLAY,
} from "@/components/pages/infra/theme";
import { InfraStage } from "./Stage";

export function InfraCta() {
	return (
		<InfraStage>
			<div className={`${styles.night} pt-14 sm:pt-20`}>
				<NightArt />
				<div className="relative mx-auto flex max-w-[640px] flex-col items-center px-5 pb-[200px] text-center sm:pb-[260px]">
					<h2 className={`${H_DISPLAY} m-0 text-[clamp(28px,3.6vw,42px)]`}>
						{HEADLINE_LINES[0]}{" "}
						<span className="sm:block">{HEADLINE_LINES[1]}</span>
					</h2>
					<div className="mt-8 flex flex-wrap justify-center gap-2.5 text-[14px] font-medium leading-none">
						<Link href={START.href} className={BTN_PRIMARY}>
							{START.label}
						</Link>
						<Link href="/infra" className={BTN_GHOST}>
							See Cap Infra
						</Link>
						<Link href={LINKS.docs} className={BTN_GHOST}>
							Read the docs
						</Link>
					</div>
					<div className="mt-8 max-w-[440px] text-balance text-[13px] leading-[1.6] text-[rgba(232,236,244,0.42)]">
						{PREVIEW_NOTE ?? TRUST.join(" ")}
					</div>
				</div>
			</div>
		</InfraStage>
	);
}
