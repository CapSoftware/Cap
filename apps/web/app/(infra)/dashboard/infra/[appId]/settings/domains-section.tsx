"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { addDeveloperDomain } from "@/actions/developers/add-domain";
import { DomainRow } from "../../_components/domain-row";
import { Button, Input, Split } from "../../_components/ui";

export function DomainsSection({
	appId,
	environment,
	domains,
}: {
	appId: string;
	environment: "development" | "production";
	domains: { id: string; domain: string }[];
}) {
	const router = useRouter();
	const inputId = useId();
	const [newDomain, setNewDomain] = useState("");

	const add = useMutation({
		mutationFn: () => addDeveloperDomain(appId, newDomain),
		onSuccess: () => {
			setNewDomain("");
			toast.success("Domain added");
			router.refresh();
		},
		onError: (error) =>
			toast.error(
				error instanceof Error ? error.message : "Could not add the domain",
			),
	});

	return (
		<Split
			title="Allowed domains"
			description={
				environment === "development"
					? "This is a development app, so its public key works from any origin. Domains here apply once you switch it to production."
					: "Your public key only works from these origins."
			}
		>
			<form
				className="flex max-w-[520px] flex-wrap items-center gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					if (!newDomain.trim() || add.isPending) return;
					add.mutate();
				}}
			>
				<label htmlFor={inputId} className="sr-only">
					Origin to allow
				</label>
				<Input
					id={inputId}
					value={newDomain}
					onChange={(e) => setNewDomain(e.target.value)}
					placeholder="https://myapp.com"
					className="min-w-[12rem] flex-1"
				/>
				<Button
					type="submit"
					variant="ghost"
					disabled={!newDomain.trim()}
					loading={add.isPending}
				>
					Add domain
				</Button>
			</form>
			{domains.length > 0 ? (
				<ul className="m-0 mt-5 max-w-[520px] list-none border-t border-[rgba(222,230,246,0.07)] p-0">
					{domains.map((d) => (
						<DomainRow
							key={d.id}
							appId={appId}
							domainId={d.id}
							domain={d.domain}
						/>
					))}
				</ul>
			) : (
				<p className="m-0 mt-4 text-[13.5px] text-[rgba(232,236,244,0.46)]">
					No domains yet.
				</p>
			)}
		</Split>
	);
}
