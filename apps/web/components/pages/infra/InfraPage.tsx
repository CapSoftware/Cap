import { Faq } from "./Faq";
import { FinalCta } from "./FinalCta";
import { Hero } from "./Hero";
import { Performance } from "./Performance";
import { Platform } from "./Platform";
import { Pricing } from "./Pricing";
import { Video } from "./Video";

export const InfraPage = () => (
	<main>
		<Hero />
		<Video />
		<Performance />
		<Platform />
		<Pricing />
		<Faq />
		<FinalCta />
	</main>
);
