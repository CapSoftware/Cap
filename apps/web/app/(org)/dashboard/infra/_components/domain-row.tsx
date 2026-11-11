"use client";

import { useMutation } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { removeDeveloperDomain } from "@/actions/developers/remove-domain";

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
		<li className="flex justify-between items-center py-2 pr-1 pl-3 rounded-lg border bg-gray-2 border-gray-4">
			<code className="font-mono text-xs truncate text-gray-12">{domain}</code>
			<button
				type="button"
				onClick={() => removeMutation.mutate()}
				disabled={removeMutation.isPending}
				aria-label={`Remove ${domain}`}
				className="inline-flex justify-center items-center rounded-md transition-colors size-7 text-gray-10 hover:bg-gray-4 hover:text-red-11 disabled:opacity-50"
			>
				<X size={14} />
			</button>
		</li>
	);
}
