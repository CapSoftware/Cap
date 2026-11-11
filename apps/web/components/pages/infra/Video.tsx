import {
	ANCHORS,
	GET_VIDEO,
	GET_VIDEO_RESPONSE,
	LADDER,
	UPLOAD_SOURCES,
	VIDEO_OUTPUTS,
} from "./content";
import { plateStyles } from "./Plain";
import { Code, Section, SectionHeading } from "./shared";
import { MONO, MUTED } from "./theme";

const Ladder = () => (
	<figure className="m-0">
		<div
			aria-hidden="true"
			className="relative flex flex-col items-center gap-2 py-4"
		>
			{LADDER.map((rung) => (
				<div
					key={rung.label}
					className="relative flex h-[58px] w-full items-center justify-center sm:h-[68px]"
				>
					<div
						className={`${plateStyles.plate} h-[96px] sm:h-[116px]`}
						style={{ width: `${rung.scale * 62}%` }}
					/>
					<span
						className="absolute top-1/2 h-px bg-[rgba(236,232,225,0.35)]"
						style={{
							left: `${50 + rung.scale * 31 + 2}%`,
							right: "64px",
						}}
					/>
					<span
						className={`${MONO} absolute right-0 top-1/2 -translate-y-1/2 text-[13px] text-[#ECE8E1]`}
					>
						{rung.label}
					</span>
				</div>
			))}
		</div>
		<figcaption className={`${MUTED} mt-4 text-center text-[14px]`}>
			Every rendition from 360p up to 4K, capped at your source.
		</figcaption>
	</figure>
);

export const Video = () => (
	<Section id={ANCHORS.video}>
		<div className="grid gap-14 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-20">
			<div className="min-w-0">
				<SectionHeading title="Upload, encode, serve.">
					<p className="m-0">
						Send a file from {UPLOAD_SOURCES[0]}, {UPLOAD_SOURCES[1]}, or{" "}
						{UPLOAD_SOURCES[2]}. When it is ready, one request gives you every
						way to play it.
					</p>
				</SectionHeading>
				<dl className="m-0 mt-10 border-b border-[rgba(236,232,225,0.08)]">
					{VIDEO_OUTPUTS.map((item) => (
						<div
							key={item.name}
							className="grid gap-1 border-t border-[rgba(236,232,225,0.08)] py-4 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-6"
						>
							<dt className="text-[15px] tracking-[-0.01em] text-[#ECE8E1]">
								{item.name}
							</dt>
							<dd className="m-0 text-[15px] leading-[1.5] text-[rgba(236,232,225,0.5)]">
								{item.detail}
							</dd>
						</div>
					))}
				</dl>
			</div>
			<div className="flex min-w-0 flex-col gap-10">
				<Ladder />
				<Code
					samples={GET_VIDEO}
					response={GET_VIDEO_RESPONSE}
					label="Get a video"
				/>
			</div>
		</div>
	</Section>
);
