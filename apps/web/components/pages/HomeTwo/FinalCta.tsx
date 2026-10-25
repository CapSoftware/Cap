import Link from "next/link";
import { BODY_TEXT, BTN_PRIMARY, BTN_SECONDARY, H_HERO } from "./theme";

export const FinalCta = () => (
	<section className="px-5 pb-28 pt-24 lg:pb-40 lg:pt-36">
		<div className="mx-auto flex max-w-[900px] flex-col items-center text-center">
			<h2 className={`${H_HERO} text-balance text-[clamp(44px,6.4vw,78px)]`}>
				Ready to upgrade how you communicate?
			</h2>
			<p
				className={`${BODY_TEXT} mt-7 max-w-[560px] text-balance text-[17px] leading-[1.5] text-[rgba(17,17,17,0.64)] sm:text-[18px]`}
			>
				All of the work around screen recordings, handled in one place. Capture,
				polish, and share without the busywork.
			</p>
			<div className="mt-9 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
				<Link href="/pricing" className={BTN_PRIMARY}>
					Upgrade to Cap Pro
				</Link>
				<Link href="/download" className={BTN_SECONDARY}>
					Download for free
				</Link>
			</div>
		</div>
	</section>
);
