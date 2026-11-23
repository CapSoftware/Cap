"use client";

import { classNames } from "@cap/utils/helpers";
import { useId, useSyncExternalStore } from "react";
import type { InfraResolutionTier } from "@/lib/infra-pricing";
import { DEFAULT_TIER, TIER_LABEL, TIERS } from "./content";

const listeners = new Set<() => void>();
let selected: InfraResolutionTier = DEFAULT_TIER;

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

const setTier = (tier: InfraResolutionTier) => {
	selected = tier;
	for (const listener of listeners) listener();
};

export const useTier = () =>
	useSyncExternalStore(
		subscribe,
		() => selected,
		() => DEFAULT_TIER,
	);

export const TierSwitch = ({
	label = "Resolution",
	className,
}: {
	label?: string;
	className?: string;
}) => {
	const tier = useTier();
	const name = useId();

	return (
		<fieldset className={classNames("m-0 min-w-0 border-0 p-0", className)}>
			<legend className="sr-only">{label}</legend>
			<div className="inline-flex gap-0.5 rounded-[9px] p-[3px] shadow-[inset_0_0_0_1px_rgba(222,230,246,0.1)]">
				{TIERS.map((option) => (
					<label key={option} className="relative cursor-pointer">
						<input
							type="radio"
							name={name}
							value={option}
							checked={tier === option}
							onChange={() => setTier(option)}
							className="peer absolute inset-0 m-0 cursor-pointer appearance-none opacity-0"
						/>
						<span className="block h-[26px] min-w-[52px] rounded-[6px] px-3 text-center text-[13px] leading-[26px] text-[rgba(232,236,244,0.5)] transition-colors duration-200 peer-hover:text-[rgba(232,236,244,0.86)] peer-checked:bg-[rgba(222,230,246,0.1)] peer-checked:text-[#E8ECF4] peer-focus-visible:ring-2 peer-focus-visible:ring-[rgba(232,236,244,0.7)]">
							{TIER_LABEL[option]}
						</span>
					</label>
				))}
			</div>
		</fieldset>
	);
};
