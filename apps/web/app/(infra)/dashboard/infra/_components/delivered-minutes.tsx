import clsx from "clsx";
import {
	DELIVERY_TIERS,
	type DeliveryJson,
	type DeliveryTier,
} from "@/lib/infra-delivery";
import { formatMinutes } from "@/lib/infra-usage";
import { Block, Empty, MONO, TD, TH, TR } from "./ui";

export const DELIVERY_TIER_LABELS: Record<DeliveryTier, string> = {
	"360p": "360p",
	"720p": "720p",
	"1080p": "1080p",
	"1440p": "1440p",
	"2160p": "4K",
};

export const NO_DELIVERY = "No delivery measured yet.";

export const DELIVERY_UNAVAILABLE = "Delivery usage unavailable.";

export const DELIVERY_MAY_CHANGE = "Today and yesterday may still change.";

export function DeliveredMinutes({
	delivery,
	monthName,
	unavailable = false,
}: {
	delivery: DeliveryJson | null;
	monthName: string;
	unavailable?: boolean;
}) {
	const tiers = delivery
		? DELIVERY_TIERS.filter((tier) => delivery.minutesByTier[tier] > 0)
		: [];
	return (
		<Block
			title="Delivered minutes"
			description="How much video your viewers watched."
		>
			{unavailable ? (
				<Empty>{DELIVERY_UNAVAILABLE}</Empty>
			) : !delivery ? (
				<Empty>{NO_DELIVERY}</Empty>
			) : (
				<>
					<table className="w-full border-collapse">
						<thead>
							<tr className={TR}>
								<th className={TH}>Resolution</th>
								<th className={clsx(TH, "text-right")}>
									Minutes in {monthName}
								</th>
							</tr>
						</thead>
						<tbody>
							{tiers.map((tier) => (
								<tr key={tier} className={TR}>
									<td className={clsx(TD, "text-[#E8ECF4]")}>
										{DELIVERY_TIER_LABELS[tier]}
									</td>
									<td
										className={clsx(
											TD,
											MONO,
											"text-right text-[13px] tabular-nums",
										)}
									>
										{formatMinutes(delivery.minutesByTier[tier])}
									</td>
								</tr>
							))}
							<tr className={TR}>
								<td className={clsx(TD, "text-[#E8ECF4]")}>Total</td>
								<td
									className={clsx(
										TD,
										MONO,
										"text-right text-[13px] tabular-nums text-white",
									)}
								>
									{formatMinutes(delivery.minutes)}
								</td>
							</tr>
						</tbody>
					</table>
					<p className="m-0 py-3 text-[12.5px] leading-[1.45] text-[rgba(232,236,244,0.46)]">
						{DELIVERY_MAY_CHANGE}
					</p>
				</>
			)}
		</Block>
	);
}
