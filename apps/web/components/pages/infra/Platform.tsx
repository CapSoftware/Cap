import type { ReactNode } from "react";
import {
	AGENT_COMMANDS,
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
	<Section className="pt-28 lg:pt-40">
		<Row
			id={ANCHORS.speech}
			title="Transcribe any file."
			samples={CREATE_TRANSCRIPT}
			label="Create a transcript"
		>
			<p>
				One request for any audio or video file, without hosting it on Cap.
				Already on a speech SDK? Change its base URL and keep your code.
			</p>
			<p className="mt-3">
				<span className="text-[#E8ECF4]">
					{usd(PRICES.speechPerHour)} per audio hour.
				</span>{" "}
				Free for videos hosted on Cap Infra.
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
				Every video has direct HLS and MP4 URLs that work in any player. Or drop
				in the Cap player embed and build nothing.
			</p>
		</Row>
		<Row
			title="Bring your agent."
			samples={AGENT_COMMANDS}
			label="Cap CLI commands"
		>
			<p>
				Apps, keys, videos and credits can all be managed from the Cap CLI and
				the Cap MCP server.
			</p>
		</Row>
	</Section>
);
