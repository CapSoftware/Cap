"use client";

import { Button, Input } from "@cap/ui";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { addDeveloperDomain } from "@/actions/developers/add-domain";
import { DomainRow } from "../../_components/domain-row";
import { Panel, Section } from "../../_components/section";

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
		<Section
			title="Allowed domains"
			description={
				environment === "development"
					? "This is a development app, so its public key works from any origin. Domains here apply once you switch it to production."
					: "Your public key only works from these origins."
			}
		>
			<Panel className="flex flex-col gap-4 p-5">
				<form
					className="flex flex-wrap gap-2 items-center"
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
						className="flex-1 min-w-[12rem] max-w-md h-9"
					/>
					<Button
						type="submit"
						variant="dark"
						size="sm"
						disabled={!newDomain.trim() || add.isPending}
						spinner={add.isPending}
					>
						Add domain
					</Button>
				</form>
				{domains.length > 0 ? (
					<ul className="flex flex-col gap-2 max-w-md">
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
					<p className="text-sm text-gray-10">No domains yet.</p>
				)}
			</Panel>
		</Section>
	);
}
