"use client";

import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { removeDeveloperDomain } from "@/actions/developers/remove-domain";
import { FOCUS, MONO } from "./ui";

export function DomainRow({
	appId,
	domainId,
	domain,
}: {
	appId: string;
	domainId: string;
	domain: string;
}) {
	const router = useRouter();
	const removeMutation = useMutation({
		mutationFn: () => removeDeveloperDomain(appId, domainId),
		onSuccess: () => {
			toast.success("Domain removed");
			router.refresh();
		},
		onError: () => {
			toast.error("Could not remove the domain");
		},
	});

	return (
		<li className="flex items-center justify-between gap-4 border-b border-[rgba(222,230,246,0.07)] py-2.5">
			<code
				className={clsx(
					MONO,
					"truncate text-[13px] text-[rgba(232,236,244,0.86)]",
				)}
			>
				{domain}
			</code>
			<button
				type="button"
				onClick={() => removeMutation.mutate()}
				disabled={removeMutation.isPending}
				aria-label={`Remove ${domain}`}
				className={clsx(
					"inline-flex size-7 shrink-0 items-center justify-center rounded-[6px] text-[rgba(232,236,244,0.4)] transition-colors duration-200 hover:bg-[rgba(242,161,153,0.1)] hover:text-[#F2A199] disabled:opacity-50",
					FOCUS,
				)}
			>
				<X size={14} />
			</button>
		</li>
	);
}
