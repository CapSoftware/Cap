import { htMono, htSans, htSerif } from "@/components/pages/HomeTwo/fonts";
import { BAND, CREAM, grainBg, SHELL } from "@/components/pages/HomeTwo/theme";
import { Capabilities } from "./Capabilities";
import { Faq } from "./Faq";
import { FinalCta } from "./FinalCta";
import { Harnesses } from "./Harnesses";
import { Hero } from "./Hero";
import { Prompts } from "./Prompts";
import { Safety } from "./Safety";
import { SetupPrompt } from "./SetupPrompt";

export const AgentsPage = () => (
	<div
		data-header-flat
		className={`${htSans.className} ${htSans.variable} ${htSerif.variable} ${htMono.variable} text-[#111111]`}
		style={grainBg(SHELL)}
	>
		<div className="px-2.5 pb-2.5 pt-[68px] sm:px-4 sm:pb-4 lg:pt-[76px]">
			<div
				className="rounded-[24px] shadow-[0_0_0_1px_rgba(17,17,17,0.045)]"
				style={grainBg(CREAM)}
			>
				<div className="rounded-[24px] rounded-b-[28px]" style={grainBg(BAND)}>
					<Hero />
				</div>
				<SetupPrompt />
				<Harnesses />
				<Capabilities />
				<Prompts />
				<Safety />
				<Faq />
				<FinalCta />
			</div>
		</div>
	</div>
);
