import {
	ANCHORS,
	GET_VIDEO,
	GET_VIDEO_RESPONSE,
	UPLOAD_SOURCES,
	VIDEO_OUTPUTS,
} from "./content";
import { Code, Section, SectionHeading } from "./shared";

export const Video = () => (
	<Section id={ANCHORS.video}>
		<div className="grid gap-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
			<div className="min-w-0">
				<SectionHeading title="Upload, encode, serve.">
					<p className="m-0">
						Send a file from {UPLOAD_SOURCES[0]}, {UPLOAD_SOURCES[1]}, or{" "}
						{UPLOAD_SOURCES[2]}. When it is ready, one request gives you every
						way to play it.
					</p>
				</SectionHeading>
				<dl className="mt-10 border-b border-[#E1E7EE]">
					{VIDEO_OUTPUTS.map((item) => (
						<div
							key={item.name}
							className="grid gap-1 border-t border-[#E1E7EE] py-4 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-6"
						>
							<dt className="text-[15.5px] tracking-[-0.01em] text-[#111111]">
								{item.name}
							</dt>
							<dd className="m-0 text-[15px] leading-[1.5] text-[rgba(17,17,17,0.62)]">
								{item.detail}
							</dd>
						</div>
					))}
				</dl>
			</div>
			<div className="min-w-0 lg:pt-2">
				<Code
					samples={GET_VIDEO}
					response={GET_VIDEO_RESPONSE}
					label="Get a video"
				/>
			</div>
		</div>
	</Section>
);
