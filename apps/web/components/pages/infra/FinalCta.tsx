import Link from "next/link";
import {
	BODY_TEXT,
	BTN_PRIMARY,
	BTN_SECONDARY,
	H_HERO,
} from "@/components/pages/HomeTwo/theme";
import { LINKS } from "./content";

export const FinalCta = () => (
	<section className="px-5 pb-24 pt-8 lg:pb-32">
		<div className="mx-auto flex max-w-[860px] flex-col items-center text-center">
			<h2 className={`${H_HERO} text-balance text-[clamp(40px,5.6vw,72px)]`}>
				Your first video is one request away.
			</h2>
			<p
				className={`${BODY_TEXT} mt-6 max-w-[520px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.76)] sm:text-[18px]`}
			>
				Create an app, grab a key and upload your first video. Encoding is on
				us.
			</p>
			<div className="mt-9 flex w-full flex-col gap-3 min-[420px]:w-auto min-[420px]:flex-row">
				<Link href={LINKS.start} className={BTN_PRIMARY}>
					Start building
				</Link>
				<Link href={LINKS.docs} className={BTN_SECONDARY}>
					Read the docs
				</Link>
			</div>
		</div>
	</section>
);
