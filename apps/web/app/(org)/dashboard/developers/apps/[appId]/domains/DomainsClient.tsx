"use client";

import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
	Input,
	Label,
} from "@cap/ui";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Plus } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { addDeveloperDomain } from "@/actions/developers/add-domain";
import { DomainRow } from "../../../_components/DomainRow";
import { useDevelopersContext } from "../../../DevelopersContext";

export function DomainsClient() {
	const { appId } = useParams<{ appId: string }>();
	const { apps } = useDevelopersContext();
	const app = apps.find((a) => a.id === appId);
	const router = useRouter();
	const domainInputId = useId();
	const [newDomain, setNewDomain] = useState("");

	const addMutation = useMutation({
		mutationFn: () => addDeveloperDomain(appId, newDomain),
		onSuccess: () => {
			setNewDomain("");
			toast.success("Domain added");
			router.refresh();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Failed to add domain",
			);
		},
	});

	if (!app) {
		return <p className="text-sm text-gray-10">App not found</p>;
	}

	return (
		<div className="flex flex-col gap-5 max-w-xl">
			{app.environment === "development" && (
				<div className="flex items-start gap-2.5 p-3 text-xs rounded-lg bg-yellow-400/10 text-yellow-200">
					<AlertTriangle
						size={14}
						className="mt-0.5 shrink-0 text-yellow-400"
					/>
					Development apps allow all localhost origins automatically.
				</div>
			)}

			<Card>
				<CardHeader>
					<CardTitle>Allowed Domains</CardTitle>
					<CardDescription>
						Restrict which domains can use your public API key.
					</CardDescription>
				</CardHeader>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						addMutation.mutate();
					}}
					className="flex gap-2 items-end mt-4"
				>
					<div className="flex flex-col flex-1 gap-1.5">
						<Label htmlFor={domainInputId} className="text-xs">
							Add Domain
						</Label>
						<Input
							id={domainInputId}
							value={newDomain}
							onChange={(e) => setNewDomain(e.target.value)}
							placeholder="https://myapp.com"
						/>
					</div>
					<Button
						type="submit"
						variant="dark"
						size="sm"
						disabled={!newDomain.trim() || addMutation.isPending}
						spinner={addMutation.isPending}
					>
						<Plus size={14} className="mr-1" />
						Add
					</Button>
				</form>

				{app.domains.length > 0 && (
					<div className="flex flex-col gap-2 mt-4 pt-4 border-t border-gray-3">
						{app.domains.map((d) => (
							<DomainRow
								key={d.id}
								appId={appId}
								domainId={d.id}
								domain={d.domain}
							/>
						))}
					</div>
				)}

				{app.domains.length === 0 && (
					<p className="mt-4 pt-4 border-t border-gray-3 text-sm text-center text-gray-10 py-4">
						No domains configured
					</p>
				)}
			</Card>
		</div>
	);
}
