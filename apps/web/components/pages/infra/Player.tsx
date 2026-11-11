import { ANCHORS, DIRECT, EMBED } from "./content";
import { Code, Section, SectionHeading } from "./shared";

export const Player = () => (
	<Section id={ANCHORS.player}>
		<SectionHeading title="Play it anywhere." className="max-w-[640px]">
			<p className="m-0">
				Drop in the Cap player, a lightweight embed with nothing to build. Or
				skip it and point any player you like at the HLS or MP4 URL.
			</p>
		</SectionHeading>
		<div className="mt-12 grid gap-5 lg:grid-cols-2">
			<Code samples={EMBED} label="Embed code" />
			<Code samples={DIRECT} label="Video tag" />
		</div>
	</Section>
);
