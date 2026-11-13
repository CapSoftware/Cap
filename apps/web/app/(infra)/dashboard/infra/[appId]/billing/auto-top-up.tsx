"use client";

import clsx from "clsx";
import { Effect } from "effect";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { removeDeveloperSavedCard } from "@/actions/developers/remove-saved-card";
import { updateDeveloperAutoTopUp } from "@/actions/developers/update-auto-topup";
import { MICRO_CREDITS_PER_DOLLAR } from "@/lib/developer-pricing";
import { useEffectMutation } from "@/lib/EffectRuntime";
import { infraAppPath } from "@/lib/infra-routes";
import { actionMessage, runAction } from "../../_components/run-action";
import { Button, FOCUS, Input, MONO } from "../../_components/ui";

const DEFAULT_THRESHOLD_DOLLARS = 5;
const DEFAULT_AMOUNT_DOLLARS = 25;
const THRESHOLD_DOLLARS = { min: 1, max: 1000 };
const AMOUNT_DOLLARS = { min: 5, max: 1000 };
const CARD_CHECKS = 6;

const NOTE =
	"m-0 max-w-[520px] text-pretty text-[13.5px] leading-[1.6] text-[rgba(232,236,244,0.58)]";

const dollars = (value: string) => Number.parseFloat(value);

const asError = (error: unknown) =>
	error instanceof Error ? error : new Error(String(error));

export function AutoTopUp({
	appId,
	hasCard,
	enabled: initialEnabled,
	thresholdMicroCredits,
	amountCents,
	failure,
}: {
	appId: string;
	hasCard: boolean;
	enabled: boolean;
	thresholdMicroCredits: number;
	amountCents: number;
	failure: { day: string; reason: string } | null;
}) {
	const router = useRouter();
	const searchParams = useSearchParams();
	const thresholdId = useId();
	const amountId = useId();
	const initialThreshold = String(
		thresholdMicroCredits > 0
			? thresholdMicroCredits / MICRO_CREDITS_PER_DOLLAR
			: DEFAULT_THRESHOLD_DOLLARS,
	);
	const initialAmount = String(
		amountCents > 0 ? amountCents / 100 : DEFAULT_AMOUNT_DOLLARS,
	);
	const [enabled, setEnabled] = useState(initialEnabled);
	const [threshold, setThreshold] = useState(initialThreshold);
	const [amount, setAmount] = useState(initialAmount);
	const [checks, setChecks] = useState(0);
	const justSaved = searchParams.get("card") === "saved";
	const waitingForCard = justSaved && !hasCard && checks < CARD_CHECKS;

	useEffect(() => {
		if (!justSaved) return;
		if (hasCard) {
			toast.success("Card saved");
			router.replace(infraAppPath(appId, "billing"));
			return;
		}
		if (checks >= CARD_CHECKS) return;
		const timer = setTimeout(() => {
			setChecks((count) => count + 1);
			router.refresh();
		}, 1500);
		return () => clearTimeout(timer);
	}, [justSaved, hasCard, checks, router, appId]);

	const saveCard = useEffectMutation({
		mutationFn: () =>
			Effect.tryPromise({
				try: async () => {
					const res = await fetch("/api/developer/credits/card", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ appId }),
					});
					const data: { url?: string } = await res.json().catch(() => ({}));
					if (!res.ok || !data.url) {
						throw new Error("Could not open the card form");
					}
					window.location.href = data.url;
				},
				catch: asError,
			}),
		onError: (cause) =>
			toast.error(actionMessage(cause, "Could not open the card form")),
	});

	const removeCard = useEffectMutation({
		mutationFn: () =>
			Effect.tryPromise({
				try: () => removeDeveloperSavedCard(appId),
				catch: asError,
			}),
		onSuccess: () => {
			setEnabled(false);
			toast.success("Card removed");
			router.refresh();
		},
		onError: () => toast.error("Could not remove the card"),
	});

	const save = useEffectMutation({
		mutationFn: () =>
			runAction(() =>
				updateDeveloperAutoTopUp({
					appId,
					enabled,
					thresholdMicroCredits: Math.round(
						dollars(threshold) * MICRO_CREDITS_PER_DOLLAR,
					),
					amountCents: Math.round(dollars(amount) * 100),
				}),
			),
		onSuccess: () => {
			toast.success(enabled ? "Auto top-up is on" : "Auto top-up is off");
			router.refresh();
		},
		onError: (cause) =>
			toast.error(actionMessage(cause, "Could not save auto top-up")),
	});

	if (!hasCard) {
		return (
			<div className="flex flex-wrap items-center gap-x-4 gap-y-3 pt-5">
				<Button
					variant="ghost"
					onClick={() => saveCard.mutate()}
					loading={saveCard.isPending || waitingForCard}
				>
					{waitingForCard ? "Saving your card" : "Save a card"}
				</Button>
				<p className={NOTE}>
					Saving a card charges nothing and leaves auto top-up off. Once you
					switch it on, Cap adds ${initialAmount} from that card whenever this
					app's balance falls below ${initialThreshold}. You can change both
					amounts, the card is charged at most once a day, and auto top-up
					switches itself off if a charge is declined. Remove the card at any
					time.
				</p>
			</div>
		);
	}

	const valid =
		!enabled ||
		(dollars(threshold) >= THRESHOLD_DOLLARS.min &&
			dollars(threshold) <= THRESHOLD_DOLLARS.max &&
			dollars(amount) >= AMOUNT_DOLLARS.min &&
			dollars(amount) <= AMOUNT_DOLLARS.max);
	const dirty =
		enabled !== initialEnabled ||
		(enabled && (threshold !== initialThreshold || amount !== initialAmount));

	return (
		<form
			className="flex flex-col gap-5 pt-5"
			onSubmit={(e) => {
				e.preventDefault();
				if (!valid) {
					toast.error(
						"Use a threshold from $1 to $1,000 and an amount from $5 to $1,000",
					);
					return;
				}
				save.mutate();
			}}
		>
			{failure && !initialEnabled && (
				<p
					role="alert"
					className="m-0 max-w-[560px] text-pretty text-[13.5px] leading-[1.6] text-[#F2A199]"
				>
					Auto top-up was switched off on {failure.day} because {failure.reason}
					. No credit was added. Add credits or save another card, then switch
					it back on.
				</p>
			)}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-3 text-[14px] text-[rgba(232,236,244,0.72)]">
				<fieldset className="m-0 inline-flex min-w-0 rounded-[9px] border-0 p-[3px] shadow-[inset_0_0_0_1px_rgba(222,230,246,0.12)]">
					<legend className="sr-only">Auto top-up</legend>
					{[false, true].map((value) => (
						<button
							key={String(value)}
							type="button"
							aria-pressed={enabled === value}
							onClick={() => setEnabled(value)}
							className={clsx(
								"h-8 rounded-[6px] px-3.5 text-[13.5px] transition-colors duration-200",
								enabled === value
									? "bg-[rgba(222,230,246,0.12)] text-white"
									: "text-[rgba(232,236,244,0.5)] hover:text-[#E8ECF4]",
								FOCUS,
							)}
						>
							{value ? "On" : "Off"}
						</button>
					))}
				</fieldset>
				{enabled && (
					<>
						<label htmlFor={thresholdId}>When the balance falls below</label>
						<span className="relative w-[96px] shrink-0">
							<span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[rgba(232,236,244,0.4)]">
								$
							</span>
							<Input
								id={thresholdId}
								inputMode="decimal"
								value={threshold}
								onChange={(e) =>
									setThreshold(e.target.value.replace(/[^0-9.]/g, ""))
								}
								className={clsx(MONO, "h-[38px] pl-6 tabular-nums")}
							/>
						</span>
						<label htmlFor={amountId}>add</label>
						<span className="relative w-[96px] shrink-0">
							<span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[rgba(232,236,244,0.4)]">
								$
							</span>
							<Input
								id={amountId}
								inputMode="decimal"
								value={amount}
								onChange={(e) =>
									setAmount(e.target.value.replace(/[^0-9.]/g, ""))
								}
								className={clsx(MONO, "h-[38px] pl-6 tabular-nums")}
							/>
						</span>
					</>
				)}
			</div>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-3">
				<Button type="submit" disabled={!dirty} loading={save.isPending}>
					Save
				</Button>
				<Button
					variant="ghost"
					onClick={() => saveCard.mutate()}
					loading={saveCard.isPending}
				>
					Replace card
				</Button>
				<Button
					variant="quiet"
					onClick={() => removeCard.mutate()}
					loading={removeCard.isPending}
				>
					Remove card
				</Button>
			</div>
			<p className={NOTE}>
				A card is saved for this app. It is charged at most once a day, and auto
				top-up switches itself off if a charge is declined.
			</p>
		</form>
	);
}
