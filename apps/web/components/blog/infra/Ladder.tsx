import { VIDEO_OUTPUTS } from "@/components/pages/infra/content";
import { PlatesArt } from "@/components/pages/infra/Plain";
import { HAIRLINE, InfraStage } from "./Stage";

/** The landing page's rendition plates, and the five things an upload gives you. */
export function InfraLadder() {
	return (
		<InfraStage caption="One upload. Every rendition is encoded at the same time, and none is ever bigger than the source.">
			<PlatesArt className="-mb-6 sm:-mb-10" />
			<dl
				className={`relative m-0 border-t px-6 pb-3 sm:px-12 sm:pb-6 ${HAIRLINE}`}
			>
				{VIDEO_OUTPUTS.map((item) => (
					<div
						key={item.name}
						className={`grid gap-1 border-b py-5 last:border-b-0 sm:grid-cols-[10rem_1fr] sm:gap-x-6 ${HAIRLINE}`}
					>
						<dt className="text-[15.5px] font-medium leading-[1.5] tracking-[-0.01em] text-[#E8ECF4]">
							{item.name}
						</dt>
						<dd className="m-0 text-pretty text-[14.5px] leading-[1.6] text-[rgba(232,236,244,0.5)]">
							{item.detail}
						</dd>
					</div>
				))}
			</dl>
		</InfraStage>
	);
}
