import { CREAM, grainBg } from "@/components/pages/HomeTwo/theme";
import { Faq } from "./Faq";
import { FinalCta } from "./FinalCta";
import { Hero } from "./Hero";
import { Player } from "./Player";
import { Pricing } from "./Pricing";
import { Speech } from "./Speech";
import { Video } from "./Video";

export const InfraPage = () => (
	<main className="px-2.5 pt-2.5 sm:px-4 sm:pt-4">
		<div
			className="overflow-hidden rounded-[24px] shadow-[0_0_0_1px_rgba(17,17,17,0.045)]"
			style={grainBg(CREAM)}
		>
			<Hero />
			<Video />
			<Speech />
			<Player />
			<Pricing />
			<Faq />
			<FinalCta />
		</div>
	</main>
);
