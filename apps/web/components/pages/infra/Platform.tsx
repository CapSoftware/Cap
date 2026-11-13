import type { ReactNode } from "react";
import {
	ANCHORS,
	type CodeSample,
	CREATE_TRANSCRIPT,
	PLAYER,
	PRICES,
	usd,
} from "./content";
import { Code, Section } from "./shared";
import { H_SECTION } from "./theme";

const Row = ({
	id,
	title,
	children,
	samples,
	label,
	group,
}: {
	id?: string;
	title: string;
	children: ReactNode;
	samples: readonly CodeSample[];
	label: string;
	group?: string;
}) => (
	<article
		id={id}
		className="grid scroll-mt-14 items-start gap-x-16 gap-y-6 border-b border-[rgba(222,230,246,0.08)] py-10 first:border-t lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:py-12"
	>
		<div>
			<h2 className={`${H_SECTION} m-0 text-[22px]`}>{title}</h2>
			<div className="mt-3 max-w-[440px] text-pretty text-[15px] leading-[1.6] text-[rgba(232,236,244,0.6)] [&_p]:m-0 [&_p]:leading-[1.6]">
				{children}
			</div>
		</div>
		<Code samples={samples} label={label} group={group} />
	</article>
);

export const Platform = () => (
	<Section className="pt-16 lg:pt-20">
		<Row
			id={ANCHORS.speech}
			title="Transcribe audio or video."
			samples={CREATE_TRANSCRIPT}
			label="Create a transcript"
		>
			<p>
				Send a public URL or upload an audio or video file and get text back,
				with word and segment timings. No video hosting needed.
			</p>
			<p className="pt-3 text-[#E8ECF4]">
				{usd(PRICES.speechPerHour)} per audio hour.
			</p>
		</Row>
		<Row
			id={ANCHORS.player}
			title="Play it anywhere."
			samples={PLAYER}
			label="Play a video"
			group="player"
		>
			<p>
				A ready video has an HLS URL, an MP4 URL and a poster that work in any
				player. One of the two can still be encoding when the video becomes
				ready, so play whichever is present. Or use the hosted player link or
				the iframe embed and build nothing.
			</p>
			<p className="pt-3">
				The embed takes autoplay, muted, loop, start time and controls as query
				parameters.
			</p>
		</Row>
	</Section>
);
