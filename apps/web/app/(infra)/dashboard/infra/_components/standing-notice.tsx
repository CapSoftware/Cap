import { infraAppPath } from "@/lib/infra-routes";
import type { InfraAppStanding } from "@/lib/infra-standing";
import { formatNeed } from "@/lib/infra-usage";
import { ButtonLink } from "./ui";

const dayFormat = new Intl.DateTimeFormat("en-US", {
	month: "long",
	day: "numeric",
	timeZone: "UTC",
});

export function StandingNotice({
	appId,
	standing,
	shortfallMicroCredits,
	action = false,
}: {
	appId: string;
	standing: InfraAppStanding;
	shortfallMicroCredits: number;
	action?: boolean;
}) {
	if (standing.state === "active" || !standing.pausesAt) return null;
	const paused = standing.state === "paused";
	const day = dayFormat.format(standing.pausesAt);
	const needed =
		shortfallMicroCredits > 0
			? ` Add ${formatNeed(shortfallMicroCredits)} or more to bring it back.`
			: " Add credits to bring it back.";

	return (
		<section
			aria-label={paused ? "Playback is paused" : "Out of credit"}
			className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4 border-t border-[rgba(242,161,153,0.24)] pt-5"
		>
			<div className="min-w-0">
				<h2 className="m-0 text-[15px] font-medium leading-[1.3] tracking-[-0.01em] text-[#F2A199]">
					{paused ? "Playback is paused" : "Out of credit"}
				</h2>
				<p className="m-0 mt-1.5 max-w-[620px] text-pretty text-[13.5px] leading-[1.55] text-[rgba(232,236,244,0.72)]">
					{paused
						? `This app ran out of credit and playback paused on ${day}. Uploads are blocked and your videos are still stored.`
						: `Uploads are blocked and playback pauses on ${day}.`}
					{needed} Days it could not pay for are not charged.
				</p>
			</div>
			{action && (
				<ButtonLink href={infraAppPath(appId, "billing")}>
					Add credits
				</ButtonLink>
			)}
		</section>
	);
}
