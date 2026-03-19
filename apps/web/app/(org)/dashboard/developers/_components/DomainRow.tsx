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
			toast.error("Failed to remove domain");
		},
	});

	return (
		<div className="flex justify-between items-center px-3 py-2 rounded-lg bg-gray-3">
			<code className="text-sm text-gray-11 font-mono">{domain}</code>
			<button
				type="button"
				onClick={() => removeMutation.mutate()}
				disabled={removeMutation.isPending}
				className="p-1 rounded-md hover:bg-gray-4 text-gray-10 hover:text-red-400 transition-colors"
			>
				<X size={14} />
			</button>
		</div>
	);
}
