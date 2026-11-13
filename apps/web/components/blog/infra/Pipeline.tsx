import { MONO } from "@/components/pages/infra/theme";
import { HAIRLINE, InfraStage, MUTED } from "./Stage";

const STEPS = [
	{
		name: "Upload",
		detail:
			"The file goes from the browser straight to storage in parts, with a token that works for that one video.",
	},
	{
		name: "Encode",
		detail:
			"On our own GPU farm, one process decodes the source once and encodes every rendition at the same time.",
	},
	{
		name: "Ready",
		detail:
			"The video is ready the moment its first output can play. The other follows.",
	},
	{
		name: "Deliver",
		detail:
			"Segments come from a CDN on signed URLs that stay the same, so repeat views are served from its cache.",
	},
	{
		name: "Play",
		detail:
			"A hosted player, an iframe embed, or the HLS and MP4 URLs in your own player.",
	},
] as const;

const NODE =
	"relative z-10 block size-[9px] shrink-0 rounded-[2px] border border-[#E8ECF4] bg-[#050506] shadow-[0_0_8px_1px_rgba(214,228,255,0.55)]";

export function InfraPipeline() {
	return (
		<InfraStage
			className="px-6 py-9 sm:px-12 sm:py-12"
			caption="The same path every Cap recording takes."
		>
			<ol className="m-0 list-none p-0">
				{STEPS.map((step, i) => (
					<li
						key={step.name}
						className="relative grid grid-cols-[9px_1fr] gap-x-5 pb-8 last:pb-0 sm:grid-cols-[9px_8.5rem_1fr] sm:gap-x-6"
					>
						{i < STEPS.length - 1 ? (
							<span
								aria-hidden="true"
								className="absolute bottom-0 left-[4px] top-[20px] w-px bg-[rgba(222,230,246,0.16)]"
							/>
						) : null}
						<span aria-hidden="true" className={`${NODE} mt-[7px]`} />
						<div className="flex items-baseline gap-2.5">
							<span
								className={`${MONO} text-[11.5px] leading-none text-[rgba(232,236,244,0.4)]`}
							>
								{String(i + 1).padStart(2, "0")}
							</span>
							<span className="text-[15.5px] font-medium leading-[1.5] tracking-[-0.01em] text-[#E8ECF4]">
								{step.name}
							</span>
						</div>
						<div
							className={`col-start-2 mt-1 text-pretty text-[14.5px] leading-[1.6] sm:col-start-3 sm:mt-0 ${MUTED}`}
						>
							{step.detail}
						</div>
					</li>
				))}
			</ol>
			<div
				className={`mt-10 grid gap-1 border-t pt-7 sm:grid-cols-[calc(9px+8.5rem+1.5rem)_1fr] sm:gap-x-6 ${HAIRLINE}`}
			>
				<span className="text-[15.5px] font-medium leading-[1.5] tracking-[-0.01em] text-[#E8ECF4]">
					Speech to text
				</span>
				<span className={`text-pretty text-[14.5px] leading-[1.6] ${MUTED}`}>
					Runs on the same GPU farm, from an upload or a public URL. The video
					doesn't have to be hosted on Cap.
				</span>
			</div>
		</InfraStage>
	);
}
