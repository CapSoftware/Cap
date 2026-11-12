"use client";

import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { CREDIT_CODE_MAX_LENGTH } from "@/lib/infra-credit-code";
import { infraAppPath } from "@/lib/infra-routes";
import {
	resolveTopUpAmount,
	TOP_UP_DEFAULT_CENTS,
	TOP_UP_PRESETS_CENTS,
	topUpButtonLabel,
} from "@/lib/infra-top-up";
import { Button, FOCUS, Input, MONO } from "../../_components/ui";

export function TopUp({ appId }: { appId: string }) {
	const router = useRouter();
	const searchParams = useSearchParams();
	const amountId = useId();
	const amountErrorId = useId();
	const [selected, setSelected] = useState<number | null>(TOP_UP_DEFAULT_CENTS);
	const [custom, setCustom] = useState("");
	const codeId = useId();
	const codeNoteId = useId();
	const [codeOpen, setCodeOpen] = useState(false);
	const [code, setCode] = useState("");

	useEffect(() => {
		if (searchParams.get("purchase") === "success") {
			toast.success("Purchase complete. Credits are added once it clears.");
			router.replace(infraAppPath(appId, "billing"));
			router.refresh();
		}
	}, [searchParams, router, appId]);

	const checkout = useMutation({
		mutationFn: async (amountCents: number) => {
			const res = await fetch("/api/developer/credits/checkout", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					appId,
					amountCents,
					...(code.trim() ? { code: code.trim() } : {}),
				}),
			});
			const data: { url?: string; error?: string } = await res
				.json()
				.catch(() => ({}));
			if (!res.ok || !data.url) {
				throw new Error(data.error ?? "Could not start checkout");
			}
			window.location.href = data.url;
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Could not start checkout",
			);
		},
	});

	const amount = resolveTopUpAmount(custom, selected);

	return (
		<form
			className="flex flex-col gap-5"
			onSubmit={(e) => {
				e.preventDefault();
				if (amount.amountCents === null) return;
				checkout.mutate(amount.amountCents);
			}}
		>
			<div className="flex flex-wrap items-center gap-3">
				<fieldset className="m-0 inline-flex min-w-0 rounded-[9px] border-0 p-[3px] shadow-[inset_0_0_0_1px_rgba(222,230,246,0.12)]">
					<legend className="sr-only">Amount to add</legend>
					{TOP_UP_PRESETS_CENTS.map((cents) => {
						const active = !amount.custom && selected === cents;
						return (
							<button
								key={cents}
								type="button"
								aria-pressed={active}
								onClick={() => {
									setSelected(cents);
									setCustom("");
								}}
								className={clsx(
									MONO,
									"h-8 rounded-[6px] px-3.5 text-[13.5px] tabular-nums transition-colors duration-200",
									active
										? "bg-[rgba(222,230,246,0.12)] text-white"
										: "text-[rgba(232,236,244,0.5)] hover:text-[#E8ECF4]",
									FOCUS,
								)}
							>
								${cents / 100}
							</button>
						);
					})}
				</fieldset>
				<div className="relative">
					<label htmlFor={amountId} className="sr-only">
						Other amount in dollars
					</label>
					<span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[14px] text-[rgba(232,236,244,0.4)]">
						$
					</span>
					<Input
						id={amountId}
						inputMode="decimal"
						value={custom}
						maxLength={16}
						aria-invalid={amount.error ? true : undefined}
						aria-describedby={amount.error ? amountErrorId : undefined}
						onChange={(e) => setCustom(e.target.value)}
						placeholder="Other, 5 to 1,000"
						className="h-[38px] w-[176px] pl-6"
					/>
				</div>
			</div>
			{amount.error && (
				<p
					id={amountErrorId}
					role="alert"
					className="m-0 -mt-2 text-[13px] leading-[1.5] text-[#F2A199]"
				>
					{amount.error}
				</p>
			)}
			{codeOpen && (
				<div className="flex max-w-[520px] flex-col gap-2">
					<label htmlFor={codeId} className="sr-only">
						Code
					</label>
					<div className="w-[240px] max-w-full">
						<Input
							id={codeId}
							value={code}
							maxLength={CREDIT_CODE_MAX_LENGTH}
							autoFocus
							autoComplete="off"
							autoCapitalize="characters"
							spellCheck={false}
							aria-describedby={codeNoteId}
							onChange={(e) => setCode(e.target.value)}
							placeholder="Code"
							className={clsx(MONO, "h-[38px]")}
						/>
					</div>
					<p
						id={codeNoteId}
						className="m-0 text-pretty text-[13px] leading-[1.5] text-[rgba(232,236,244,0.5)]"
					>
						A code lowers what you pay for this purchase. The credit you get is
						the amount you chose.
					</p>
				</div>
			)}
			<div className="flex flex-wrap items-center gap-2">
				<Button
					type="submit"
					disabled={amount.amountCents === null}
					aria-describedby={amount.error ? amountErrorId : undefined}
					loading={checkout.isPending}
				>
					{topUpButtonLabel(amount)}
				</Button>
				{!codeOpen && (
					<Button variant="quiet" onClick={() => setCodeOpen(true)}>
						Have a code?
					</Button>
				)}
			</div>
		</form>
	);
}
