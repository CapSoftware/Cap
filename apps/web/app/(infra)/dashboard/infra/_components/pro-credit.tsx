"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { claimDeveloperProCredit } from "@/actions/developers/claim-pro-credit";
import { useEffectMutation } from "@/lib/EffectRuntime";
import type { InfraProCredit } from "../infra-data";
import { actionMessage, runAction } from "./run-action";
import { Button, TEXT_LINK } from "./ui";

const dateFormat = new Intl.DateTimeFormat("en-US", {
	month: "long",
	day: "numeric",
	timeZone: "UTC",
});

const NOTE =
	"m-0 max-w-[520px] text-pretty text-[13.5px] leading-[1.6] text-[rgba(232,236,244,0.58)]";

export function ProCredit({
	appId,
	credit,
	refresh = true,
}: {
	appId: string;
	credit: InfraProCredit;
	refresh?: boolean;
}) {
	const router = useRouter();
	const [claimedHere, setClaimedHere] = useState(false);

	const claim = useEffectMutation({
		mutationFn: () => runAction(() => claimDeveloperProCredit(appId)),
		onSuccess: () => {
			setClaimedHere(true);
			toast.success("$5 credit added to this app");
			if (refresh) router.refresh();
		},
		onError: (cause) =>
			toast.error(actionMessage(cause, "Could not claim the credit")),
	});

	if (credit.status === "not_pro") {
		return (
			<p className={NOTE}>
				Cap Pro includes $5 of Infra credit every month.{" "}
				<Link href="/pricing" className={TEXT_LINK}>
					See Cap Pro
				</Link>
			</p>
		);
	}

	if (claimedHere || credit.status === "claimed") {
		return (
			<p className={NOTE}>
				{claimedHere
					? "This month's $5 Cap Pro credit is in this app's balance."
					: "This month's $5 Cap Pro credit is already claimed."}{" "}
				It is one per account each month, not one per app. The next one is ready
				on {dateFormat.format(new Date(credit.nextDate))}.
			</p>
		);
	}

	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-3">
			<Button onClick={() => claim.mutate()} loading={claim.isPending}>
				Claim $5 credit
			</Button>
			<p className={NOTE}>
				Cap Pro includes one $5 Infra credit a month for your whole account, not
				one per app. Claiming it here adds it to this app, and it cannot be
				moved afterwards.
			</p>
		</div>
	);
}
