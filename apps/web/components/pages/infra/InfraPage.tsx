import { Faq } from "./Faq";
import { FinalCta } from "./FinalCta";
import { Hero } from "./Hero";
import { Player } from "./Player";
import { Pricing } from "./Pricing";
import { Speech } from "./Speech";
import { Video } from "./Video";

export const InfraPage = () => (
	<main>
		<Hero />
		<div className="pt-24 lg:pt-32">
			<Video />
		</div>
		<Speech />
		<Player />
		<Pricing />
		<Faq />
		<FinalCta />
	</main>
);
