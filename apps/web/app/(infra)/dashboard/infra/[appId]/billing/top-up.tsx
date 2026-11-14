"use client";

import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { CREDIT_CODE_MAX_LENGTH } from "@/lib/infra-credit-code";
import {
	CREDIT_US_EIN_INVALID,
	CREDIT_US_EIN_MAX_LENGTH,
	parseCreditUsEin,
} from "@/lib/infra-credit-us-ein";
import { infraAppPath } from "@/lib/infra-routes";
import {
	resolveTopUpAmount,
	TOP_UP_AMOUNT_PLACEHOLDER,
	TOP_UP_DEFAULT_CENTS,
	TOP_UP_PRESETS_CENTS,
	topUpButtonLabel,
	topUpCoversText,
} from "@/lib/infra-top-up";
import { Button, FOCUS, Input, MONO, TEXT_LINK } from "../../_components/ui";

export function TopUp({
	appId,
	autoTopUpHref,
}: {
	appId: string;
	autoTopUpHref: string | null;
}) {
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
	const einId = useId();
	const einNoteId = useId();
	const einErrorId = useId();
	const [einOpen, setEinOpen] = useState(false);
	const [usEin, setUsEin] = useState("");
	const [purchased] = useState(
		() => searchParams.get("purchase") === "success",
	);

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
					...(ein.state === "valid" ? { usEin: ein.ein } : {}),
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
	const ein = parseCreditUsEin(einOpen ? usEin : undefined);
	const einInvalid = ein.state === "invalid";

	return (
		<form
			className="flex flex-col gap-5"
			onSubmit={(e) => {
				e.preventDefault();
				if (amount.amountCents === null || einInvalid) return;
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
						placeholder={TOP_UP_AMOUNT_PLACEHOLDER}
						className="h-[38px] w-[176px] pl-6"
					/>
				</div>
			</div>
			<p className="m-0 -mt-2 max-w-[520px] text-pretty text-[13px] leading-[1.5] text-[rgba(232,236,244,0.5)]">
				{topUpCoversText()}
			</p>
			{!einOpen && (
				<p className="m-0 -mt-3 max-w-[520px] text-pretty text-[13px] leading-[1.5] text-[rgba(232,236,244,0.5)]">
					US business?{" "}
					<button
						type="button"
						onClick={() => setEinOpen(true)}
						className={clsx(TEXT_LINK, FOCUS, "rounded-[4px]")}
					>
						Add your EIN
					</button>{" "}
					before you pay so it is on your invoice.
				</p>
			)}
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
			{einOpen && (
				<div className="flex max-w-[520px] flex-col gap-2">
					<label htmlFor={einId} className="sr-only">
						US EIN
					</label>
					<div className="w-[240px] max-w-full">
						<Input
							id={einId}
							value={usEin}
							maxLength={CREDIT_US_EIN_MAX_LENGTH}
							autoFocus
							autoComplete="off"
							inputMode="numeric"
							spellCheck={false}
							aria-invalid={einInvalid ? true : undefined}
							aria-describedby={einInvalid ? einErrorId : einNoteId}
							onChange={(e) => setUsEin(e.target.value)}
							placeholder="US EIN, 12-3456789"
							className={clsx(MONO, "h-[38px]")}
						/>
					</div>
					{einInvalid ? (
						<p
							id={einErrorId}
							role="alert"
							className="m-0 text-[13px] leading-[1.5] text-[#F2A199]"
						>
							{CREDIT_US_EIN_INVALID}.
						</p>
					) : (
						<p
							id={einNoteId}
							className="m-0 text-pretty text-[13px] leading-[1.5] text-[rgba(232,236,244,0.5)]"
						>
							For a US business. It is saved to your billing details, so it
							shows on the invoice for this purchase and later ones.
						</p>
					)}
				</div>
			)}
			<div className="flex flex-wrap items-center gap-2">
				<Button
					type="submit"
					disabled={amount.amountCents === null || einInvalid}
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
			{purchased && autoTopUpHref && (
				<p className="m-0 max-w-[520px] text-pretty text-[13px] leading-[1.5] text-[rgba(232,236,244,0.5)]">
					Switch on{" "}
					<a
						href={autoTopUpHref}
						className={clsx(TEXT_LINK, FOCUS, "rounded-[4px]")}
					>
						auto top-up
					</a>{" "}
					to add credit as soon as the balance falls below a threshold you set.
				</p>
			)}
		</form>
	);
}
