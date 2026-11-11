import { Agent } from "./Agent";
import { Compare } from "./Compare";
import { Faq } from "./Faq";
import { FinalCta } from "./FinalCta";
import { Hero } from "./Hero";
import { Performance } from "./Performance";
import { Platform } from "./Platform";
import { Pricing } from "./Pricing";
import { ProCredit } from "./ProCredit";
import { Video } from "./Video";

export const InfraPage = () => (
	<main>
		<Hero />
		<Agent />
		<Compare />
		<Performance />
		<Video />
		<Platform />
		<Pricing />
		<ProCredit />
		<Faq />
		<FinalCta />
	</main>
);
