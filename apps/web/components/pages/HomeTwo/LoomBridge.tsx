"use client";

import { classNames } from "@cap/utils/helpers";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { trackEvent } from "@/app/utils/analytics";
import { LoomMark } from "@/components/icons/LoomMark";
import { MigratePromoBadge } from "@/components/MigratePromoBadge";
import { Eyebrow } from "./Eyebrow";
import { BAND, BODY_TEXT, BTN_PRIMARY, grainBg, MODE_THEME } from "./theme";

export const LoomBridge = () => (
	<section className="px-5 pb-4 pt-2">
		<div
			className="mx-auto flex max-w-[1200px] flex-col items-start justify-between gap-8 rounded-[20px] p-8 lg:flex-row lg:items-center lg:p-12"
			style={grainBg(BAND)}
		>
			<div className="max-w-[560px]">
				<Eyebrow accent={MODE_THEME.instant.accent}>
					Switching from Loom
				</Eyebrow>
				<h2 className="mt-5 text-balance text-[clamp(28px,3.2vw,40px)] font-normal leading-[1.05] tracking-[-0.03em] text-[#111111]">
					Bring your whole Loom library with you
				</h2>
				<p
					className={`${BODY_TEXT} mt-4 max-w-[500px] text-[16px] leading-[1.5] text-[rgba(17,17,17,0.78)]`}
				>
					Paste a Loom link or upload a CSV of your library and Cap re-hosts
					every video with its title, a transcript and chapters. Your recordings
					land in storage you own, on a plan that stays free.
				</p>
			</div>

			<div className="flex flex-col items-start gap-3 lg:items-end">
				<Link
					href="/migrate-from-loom"
					onClick={() =>
						trackEvent("loom_import_cta_clicked", {
							source_page: "home_loom_bridge",
							cta_location: "primary",
						})
					}
					className={classNames(BTN_PRIMARY, "gap-2.5")}
				>
					<LoomMark size={16} />
					Import from Loom
					<ArrowRight className="size-4" />
				</Link>
				<MigratePromoBadge sourcePage="home_loom_bridge" />
			</div>
		</div>
	</section>
);
