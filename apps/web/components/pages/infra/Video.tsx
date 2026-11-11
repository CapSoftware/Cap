import {
	ANCHORS,
	GET_VIDEO_RESPONSE,
	UPLOAD_SOURCES,
	VIDEO_FLOW,
	VIDEO_OUTPUTS,
} from "./content";
import { PlatesArt } from "./Plain";
import { Code, Section, SectionHeading } from "./shared";

export const Video = () => (
	<section id={ANCHORS.video} className="scroll-mt-14 pt-16 lg:pt-10">
		<div className="relative mx-auto max-w-[1680px]">
			<div className="px-5 sm:px-8 lg:absolute lg:inset-0 lg:z-10 lg:flex lg:items-center">
				<div className="mx-auto w-full max-w-[1120px]">
					<SectionHeading
						title="One upload. Every resolution."
						className="max-w-[360px]"
					>
						<p>
							Send a file from {UPLOAD_SOURCES[0]}, {UPLOAD_SOURCES[1]}, or{" "}
							{UPLOAD_SOURCES[2]}. Cap encodes it once for every screen and
							serves it from a CDN.
						</p>
					</SectionHeading>
				</div>
			</div>
			<PlatesArt className="mt-4 lg:mt-0" />
		</div>
		<Section>
			<dl className="m-0 grid border-t border-[rgba(222,230,246,0.08)] sm:grid-cols-2 lg:grid-cols-5">
				{VIDEO_OUTPUTS.map((item) => (
					<div
						key={item.name}
						className="border-b border-[rgba(222,230,246,0.08)] py-4 sm:pr-6 lg:border-b-0 lg:py-5"
					>
						<dt className="text-[14px] font-medium tracking-[-0.01em] text-[#E8ECF4]">
							{item.name}
						</dt>
						<dd className="m-0 mt-1.5 text-pretty text-[13.5px] leading-[1.5] text-[rgba(232,236,244,0.5)]">
							{item.detail}
						</dd>
					</div>
				))}
			</dl>
			<Code
				className="mt-6 lg:mt-8"
				samples={VIDEO_FLOW}
				response={GET_VIDEO_RESPONSE}
				responseLabel="When it is ready"
				label="Upload and fetch a video"
			/>
		</Section>
	</section>
);
