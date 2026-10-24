import Link from "next/link";
import { Eyebrow } from "./Eyebrow";
import { BODY_TEXT, BTN_PRIMARY, MODE_THEME, SANS } from "./theme";

export const FinalCta = () => (
	<section className="px-5 pb-4 pt-2">
		<div className="mx-auto flex max-w-[1200px] flex-col items-center rounded-[28px] bg-[#111111] px-6 py-16 text-center sm:px-10 lg:py-24">
			<Eyebrow accent={MODE_THEME.share.accent} color="rgba(255,255,255,0.62)">
				Get started
			</Eyebrow>
			<h2
				className={`${SANS} mt-6 max-w-[820px] text-balance text-[clamp(40px,6vw,72px)] font-normal leading-[1.0] tracking-[-0.03em] text-white`}
			>
				Ready to upgrade how you communicate?
			</h2>
			<p
				className={`${BODY_TEXT} mt-7 max-w-[560px] text-balance text-[16.5px] leading-[1.5] text-white/70 sm:text-[18px]`}
			>
				All of the work around screen recordings, handled in one place. Capture,
				polish, and share without the busywork.
			</p>
			<div className="mt-9 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
				<Link href="/pricing" className={BTN_PRIMARY}>
					Upgrade to Cap Pro
				</Link>
				<Link
					href="/download"
					className="inline-flex h-[48px] items-center justify-center rounded-[10px] border border-white/20 bg-white/[0.06] px-6 text-[16px] font-normal text-white transition-colors duration-200 hover:bg-white/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#111111]"
				>
					Download for free
				</Link>
			</div>
			<p className="mt-7 text-[13.5px] text-white/55">
				No credit card &middot; Open source
			</p>
		</div>
	</section>
);
