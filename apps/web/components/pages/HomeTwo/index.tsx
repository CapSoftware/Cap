import { Agents } from "@/components/pages/HomeTwo/Agents";
import { DeepDives } from "@/components/pages/HomeTwo/DeepDives";
import { Faq } from "@/components/pages/HomeTwo/Faq";
import { Features } from "@/components/pages/HomeTwo/Features";
import { FinalCta } from "@/components/pages/HomeTwo/FinalCta";
import { htMono, htSans, htSerif } from "@/components/pages/HomeTwo/fonts";
import { Hero } from "@/components/pages/HomeTwo/Hero";
import { LoomBridge } from "@/components/pages/HomeTwo/LoomBridge";
import { ModeWalkthrough } from "@/components/pages/HomeTwo/ModeWalkthrough";
import { Ownership } from "@/components/pages/HomeTwo/Ownership";
import { Platforms } from "@/components/pages/HomeTwo/Platforms";
import { Pricing } from "@/components/pages/HomeTwo/Pricing";
import { Testimonials } from "@/components/pages/HomeTwo/Testimonials";
import { BAND, CREAM, grainBg, SHELL } from "@/components/pages/HomeTwo/theme";
import { Workflow } from "@/components/pages/HomeTwo/Workflow";
import { HomeTwoSchema } from "./Schema";

const CARD_RADIUS = "rounded-[24px]";

export function HomeTwoPage() {
	// No overflow clipping anywhere on the card: it would trap the walkthrough's
	// sticky card. The corners are cut on the card and on the band that paints
	// over them instead.
	return (
		<div
			className={`${htSans.className} ${htSans.variable} ${htSerif.variable} ${htMono.variable} text-[#111111]`}
			style={grainBg(SHELL)}
		>
			<HomeTwoSchema />
			<div className="px-2.5 pb-2.5 pt-[68px] sm:px-4 sm:pb-4 lg:pt-[76px]">
				<div
					className={`${CARD_RADIUS} shadow-[0_0_0_1px_rgba(17,17,17,0.045)]`}
					style={grainBg(CREAM)}
				>
					{/* Band one: the hero flows straight into the pinned walkthrough so
					    the gradient card already peeks into the first viewport. It
					    carries the card's top corners because it paints over them. */}
					<div
						className={`${CARD_RADIUS} rounded-b-[28px]`}
						style={grainBg(BAND)}
					>
						<Hero />
						<ModeWalkthrough />
					</div>
					<Workflow />
					<DeepDives />
					<Features />
					<Ownership />
					<Platforms />
					<Agents />
					<Testimonials />
					<Pricing />
					<Faq />
					<LoomBridge />
					<FinalCta />
				</div>
			</div>
		</div>
	);
}
