import { Download } from "lucide-react";
import { DownloadCtaLink } from "@/components/download/DownloadCtaLink";
import { BODY_TEXT, BTN_PRIMARY, H_CARD } from "./theme";

export const MidCta = () => (
	<section className="px-5 pb-6 pt-2 lg:pb-10">
		<div className="mx-auto flex max-w-[1060px] flex-col items-center gap-6 rounded-[24px] bg-white px-6 py-10 text-center shadow-[0_0_0_1px_rgba(17,17,17,0.06),0_1px_2px_rgba(17,17,17,0.03)] md:flex-row md:justify-between md:px-10 md:text-left">
			<div>
				<h2 className={`${H_CARD} text-[clamp(26px,3vw,34px)]`}>
					Try it on your next recording
				</h2>
				<p
					className={`${BODY_TEXT} mt-3 max-w-[520px] text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.72)]`}
				>
					Cap is free to download. Record locally, and share when you choose.
				</p>
			</div>
			<DownloadCtaLink
				sourcePage="home_mid"
				ctaLocation="after_studio"
				className={`${BTN_PRIMARY} w-full shrink-0 md:w-auto`}
			>
				<Download className="mr-2.5 size-[18px]" />
				Download free
			</DownloadCtaLink>
		</div>
	</section>
);
