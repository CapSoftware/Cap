"use client";

import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { infraAppPath } from "@/lib/infra-routes";
import { Button, FOCUS, Input, MONO } from "../../_components/ui";

const presets = [1000, 2500, 5000, 10000];
const MIN_CENTS = 500;
const MAX_CENTS = 100_000;

export function TopUp({ appId }: { appId: string }) {
	const router = useRouter();
	const searchParams = useSearchParams();
	const amountId = useId();
	const [selected, setSelected] = useState<number | null>(2500);
	const [custom, setCustom] = useState("");

	useEffect(() => {
		if (searchParams.get("purchase") === "success") {
			toast.success("Payment received. Credits are added once it clears.");
			router.replace(infraAppPath(appId, "billing"));
			router.refresh();
		}
	}, [searchParams, router, appId]);

	const checkout = useMutation({
		mutationFn: async (amountCents: number) => {
			const res = await fetch("/api/developer/credits/checkout", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ appId, amountCents }),
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

	const customCents = custom.trim()
		? Math.round(Number.parseFloat(custom) * 100)
		: null;
	const amountCents = customCents ?? selected;
	const valid =
		amountCents !== null &&
		Number.isFinite(amountCents) &&
		amountCents >= MIN_CENTS &&
		amountCents <= MAX_CENTS;

	return (
		<form
			className="flex flex-col gap-5"
			onSubmit={(e) => {
				e.preventDefault();
				if (!valid || amountCents === null) {
					toast.error("Enter an amount between $5 and $1,000");
					return;
				}
				checkout.mutate(amountCents);
			}}
		>
			<div className="flex flex-wrap items-center gap-3">
				<fieldset className="m-0 inline-flex min-w-0 rounded-[9px] border-0 p-[3px] shadow-[inset_0_0_0_1px_rgba(222,230,246,0.12)]">
					<legend className="sr-only">Amount to add</legend>
					{presets.map((cents) => {
						const active = customCents === null && selected === cents;
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
						onChange={(e) => setCustom(e.target.value.replace(/[^0-9.]/g, ""))}
						placeholder="Other, 5 to 1,000"
						className="h-[38px] w-[176px] pl-6"
					/>
				</div>
			</div>
			<Button
				type="submit"
				className="self-start"
				disabled={!valid}
				loading={checkout.isPending}
			>
				{valid && amountCents !== null
					? `Add $${(amountCents / 100).toLocaleString("en-US", {
							minimumFractionDigits: amountCents % 100 === 0 ? 0 : 2,
							maximumFractionDigits: 2,
						})}`
					: "Add credits"}
			</Button>
		</form>
	);
}
