"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { claimDeveloperProCredit } from "@/actions/developers/claim-pro-credit";
import type { InfraProCredit } from "../infra-data";
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
	const [claimed, setClaimed] = useState(credit.status === "claimed");

	const claim = useMutation({
		mutationFn: () => claimDeveloperProCredit(appId),
		onSuccess: () => {
			setClaimed(true);
			toast.success("$5 credit added");
			if (refresh) router.refresh();
		},
		onError: (error) =>
			toast.error(
				error instanceof Error ? error.message : "Could not claim the credit",
			),
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

	if (claimed) {
		return (
			<p className={NOTE}>
				This month's $5 Cap Pro credit is in your balance. The next one is ready
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
				Your Cap Pro plan includes $5 of Infra credit every month.
			</p>
		</div>
	);
}
