import { ANCHORS, CREATE_TRANSCRIPT, PRICES, usd } from "./content";
import { Code, Section, SectionHeading } from "./shared";

export const Speech = () => (
	<Section id={ANCHORS.speech} className="bg-[#EDF1F6]/60">
		<div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-16">
			<div className="order-2 min-w-0 lg:order-1">
				<Code samples={CREATE_TRANSCRIPT} label="Create a transcript" />
			</div>
			<div className="order-1 min-w-0 lg:order-2">
				<SectionHeading title="Transcribe any file with one request.">
					<p className="m-0">
						The speech API works on its own. Send audio or video from anywhere
						and get a transcript back, without hosting the file on Cap.
					</p>
					<p className="m-0 mt-4">
						Already on a speech SDK? Change its base URL to Cap and keep your
						code.
					</p>
				</SectionHeading>
				<p className="mt-8 text-[15px] leading-[1.5] text-[rgba(17,17,17,0.62)]">
					<span className="text-[#111111]">
						{usd(PRICES.speechPerHour)} per hour of audio.
					</span>{" "}
					Free for videos hosted on Cap Infra.
				</p>
			</div>
		</div>
	</Section>
);
