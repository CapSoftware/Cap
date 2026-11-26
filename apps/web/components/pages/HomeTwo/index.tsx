import { DiscordLinkPreview } from "@/components/pages/HomeTwo/DiscordLinkPreview";
import { Faq } from "@/components/pages/HomeTwo/Faq";
import { FinalCta } from "@/components/pages/HomeTwo/FinalCta";
import { htMono, htSans, htSerif } from "@/components/pages/HomeTwo/fonts";
import { Hero } from "@/components/pages/HomeTwo/Hero";
import { LoomBridge } from "@/components/pages/HomeTwo/LoomBridge";
import { MidCta } from "@/components/pages/HomeTwo/MidCta";
import { ModeWalkthrough } from "@/components/pages/HomeTwo/ModeWalkthrough";
import { Pricing } from "@/components/pages/HomeTwo/Pricing";
import { SectionView } from "@/components/pages/HomeTwo/SectionView";
import { Testimonials } from "@/components/pages/HomeTwo/Testimonials";
import { BAND, CREAM, grainBg, SHELL } from "@/components/pages/HomeTwo/theme";
import { HomeTwoSchema } from "./Schema";
import { FADE_CSS, POP_CSS } from "./showcase/layout";
import { PlatformsSection } from "./showcase/platforms";
import {
	AgentsSection,
	AiSection,
	InstantSection,
	OwnershipSection,
	ScreenshotSection,
	StudioSection,
} from "./showcase/sections";

const CARD_RADIUS = "rounded-[24px]";

export function HomeTwoPage() {
	// No overflow clipping anywhere on the card: it would trap the walkthrough's
	// sticky card. The corners are cut on the card and on the band that paints
	// over them instead.
	return (
		<div
			data-header-flat
			className={`${htSans.className} ${htSans.variable} ${htSerif.variable} ${htMono.variable} text-[#111111]`}
			style={grainBg(SHELL)}
		>
			<style>{FADE_CSS + POP_CSS}</style>
			<HomeTwoSchema />
			<DiscordLinkPreview />
			<div className="px-2.5 pb-2.5 pt-[68px] sm:px-5 sm:pb-4 lg:px-8 lg:pt-[76px]">
				<div
					className={`${CARD_RADIUS} shadow-[0_0_0_1px_rgba(17,17,17,0.045)]`}
					style={grainBg(CREAM)}
				>
					<div
						className={`${CARD_RADIUS} rounded-b-[28px]`}
						style={grainBg(BAND)}
					>
						<Hero />
						<ModeWalkthrough />
					</div>
					<InstantSection />
					<SectionView section="studio" />
					<StudioSection />
					<MidCta />
					<ScreenshotSection />
					<AiSection />
					<OwnershipSection />
					<SectionView section="platforms" />
					<PlatformsSection />
					<AgentsSection />
					<Testimonials eyebrow={false} />
					<SectionView section="pricing" />
					<Pricing />
					<Faq eyebrow={false} />
					<LoomBridge />
					<SectionView section="final_cta" />
					<FinalCta />
				</div>
			</div>
		</div>
	);
}
