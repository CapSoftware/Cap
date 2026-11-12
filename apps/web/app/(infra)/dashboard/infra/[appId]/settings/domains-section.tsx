"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { addDeveloperDomain } from "@/actions/developers/add-domain";
import { useEffectMutation } from "@/lib/EffectRuntime";
import { normalizeAllowedOrigin } from "@/lib/infra-domain";
import { DomainRow } from "../../_components/domain-row";
import { actionMessage, runAction } from "../../_components/run-action";
import { Button, Input, Split } from "../../_components/ui";

export function DomainsSection({
	appId,
	domains,
}: {
	appId: string;
	domains: { id: string; domain: string }[];
}) {
	const router = useRouter();
	const inputId = useId();
	const problemId = useId();
	const [newDomain, setNewDomain] = useState("");
	const [problem, setProblem] = useState<string | null>(null);

	const add = useEffectMutation({
		mutationFn: (origin: string) =>
			runAction(() => addDeveloperDomain(appId, origin)),
		onSuccess: (result) => {
			setNewDomain("");
			toast.success(`${result.domain} added`);
			router.refresh();
		},
		onError: (cause) =>
			setProblem(actionMessage(cause, "Could not add the domain. Try again.")),
	});

	return (
		<Split
			title="Allowed domains"
			description="Your sites, for reference. Uploads are authorised by upload tokens from your server. To hold a token to one site, set corsOrigin when you create the upload."
		>
			<form
				className="flex max-w-[520px] flex-wrap items-center gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					if (!newDomain.trim() || add.isPending) return;
					const allowed = normalizeAllowedOrigin(newDomain);
					if (!allowed.ok) {
						setProblem(allowed.message);
						return;
					}
					setProblem(null);
					add.mutate(allowed.origin);
				}}
			>
				<label htmlFor={inputId} className="sr-only">
					Website to allow
				</label>
				<Input
					id={inputId}
					value={newDomain}
					onChange={(e) => {
						setNewDomain(e.target.value);
						setProblem(null);
					}}
					placeholder="myshop.com"
					autoComplete="off"
					autoCapitalize="none"
					spellCheck={false}
					inputMode="url"
					aria-invalid={problem ? true : undefined}
					aria-describedby={problem ? problemId : undefined}
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
			{problem && (
				<p
					id={problemId}
					role="alert"
					className="m-0 mt-2.5 max-w-[520px] text-pretty text-[13px] leading-[1.5] text-[#F2A199]"
				>
					{problem}
				</p>
			)}
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
