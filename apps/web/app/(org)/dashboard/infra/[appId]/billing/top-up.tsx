"use client";

import { Button, Input } from "@cap/ui";
import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { infraAppPath } from "@/lib/infra-routes";

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
			className="flex flex-col gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				if (!valid || amountCents === null) {
					toast.error("Enter an amount between $5 and $1,000");
					return;
				}
				checkout.mutate(amountCents);
			}}
		>
			<div className="flex flex-wrap gap-2">
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
								"px-4 h-9 text-sm tabular-nums rounded-full border transition-colors",
								active
									? "bg-gray-12 border-gray-12 text-gray-1"
									: "border-gray-4 text-gray-12 hover:border-gray-6",
							)}
						>
							${cents / 100}
						</button>
					);
				})}
			</div>
			<div className="flex flex-wrap gap-2 items-center">
				<label htmlFor={amountId} className="text-sm text-gray-10">
					Other amount
				</label>
				<div className="relative">
					<span className="absolute left-3 top-1/2 text-sm -translate-y-1/2 text-gray-10">
						$
					</span>
					<Input
						id={amountId}
						inputMode="decimal"
						value={custom}
						onChange={(e) => setCustom(e.target.value.replace(/[^0-9.]/g, ""))}
						placeholder="5 to 1,000"
						className="pl-6 w-32 h-9"
					/>
				</div>
			</div>
			<Button
				type="submit"
				variant="dark"
				size="sm"
				className="self-start"
				disabled={!valid || checkout.isPending}
				spinner={checkout.isPending}
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
