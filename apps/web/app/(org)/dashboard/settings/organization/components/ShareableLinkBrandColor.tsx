"use client";

import { faPlay } from "@fortawesome/free-solid-svg-icons/faPlay";
import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, Pipette } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { updateShareableLinkBrandColor } from "@/actions/organization/shareable-link-icon";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";
import { UpgradeModal } from "@/components/UpgradeModal";
import {
	playerBrandAttributes,
	playerColorFromOrganizationMetadata,
	resolvePlayerBrand,
} from "@/lib/player-brand";
import { normalizeHexColor } from "@/lib/share-call-to-action";
import { useDashboardContext } from "../../../Contexts";
import { ProChip, SettingsRow } from "../_components/settings-ui";

const CAP_PLAY_BLUE = "#3B82F6";

function brandPalette(metadata: unknown): string[] {
	if (typeof metadata !== "object" || metadata === null) return [];
	const branding = (metadata as { branding?: unknown }).branding;
	if (typeof branding !== "object" || branding === null) return [];
	const colors = (branding as { colors?: unknown }).colors;
	if (typeof colors !== "object" || colors === null) return [];
	const values = ["primary", "secondary", "accent", "background"]
		.map((key) => normalizeHexColor((colors as Record<string, unknown>)[key]))
		.filter((value): value is string => value !== null);
	return [...new Set(values)];
}

export const ShareableLinkBrandColor = () => {
	const router = useRouter();
	const hexInputId = useId();
	const noteId = useId();
	const { activeOrganization, user } = useDashboardContext();
	const organization = activeOrganization?.organization;
	const organizationId = organization?.id;
	const savedColor = playerColorFromOrganizationMetadata(
		organization?.metadata,
	);
	const palette = useMemo(
		() => brandPalette(organization?.metadata),
		[organization?.metadata],
	);

	const [draft, setDraft] = useState<string | null>(savedColor);
	const [hexText, setHexText] = useState(savedColor ?? "");
	const [showUpgradeModal, setShowUpgradeModal] = useState(false);

	useEffect(() => {
		setDraft(savedColor);
		setHexText(savedColor ?? "");
	}, [savedColor]);

	const save = useMutation({
		mutationFn: (color: string | null) => {
			if (!organizationId) throw new Error("No organization selected");
			return updateShareableLinkBrandColor({ organizationId, color });
		},
		onSuccess: (result) => {
			toast.success(
				result.color ? "Brand color saved" : "Share pages use Cap blue again",
			);
			router.refresh();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Couldn't save brand color",
			);
		},
	});

	const choose = (color: string | null) => {
		if (!user.isPro) {
			setShowUpgradeModal(true);
			return;
		}
		setDraft(color);
		setHexText(color ?? "");
	};

	const hexValid = hexText === "" || normalizeHexColor(hexText) !== null;
	const dirty = draft !== savedColor;
	const brand = resolvePlayerBrand(draft);
	const customSelected =
		draft !== null && !palette.includes(draft) && draft !== CAP_PLAY_BLUE;

	return (
		<>
			<SettingsRow
				title="Brand color"
				meta={<ProChip />}
				description="Colors the play button, progress bar and focus rings on your share pages and embeds."
			>
				<div className="flex flex-col gap-5 mt-4 md:flex-row md:items-start">
					<div className="flex flex-col flex-1 gap-4 min-w-0">
						<fieldset className="flex flex-wrap gap-2 items-center">
							<legend className="sr-only">Brand color</legend>
							<Swatch
								label="Cap blue"
								color={CAP_PLAY_BLUE}
								selected={draft === null}
								disabled={save.isPending}
								onSelect={() => choose(null)}
							/>
							{palette.map((color) => (
								<Swatch
									key={color}
									label={`Brand color ${color}`}
									color={color}
									selected={draft === color}
									disabled={save.isPending}
									onSelect={() => choose(color)}
								/>
							))}
							<label
								className={clsx(
									"flex relative justify-center items-center rounded-full transition-transform cursor-pointer size-8 hover:scale-105 focus-within:ring-2 focus-within:ring-blue-9 focus-within:ring-offset-2 focus-within:ring-offset-gray-1",
									customSelected
										? "ring-2 ring-gray-12 ring-offset-2 ring-offset-gray-1"
										: "border border-dashed border-gray-6",
								)}
								style={customSelected ? { background: draft } : undefined}
							>
								<span className="sr-only">Custom color</span>
								<input
									type="color"
									value={draft ?? CAP_PLAY_BLUE}
									disabled={save.isPending}
									onChange={(event) =>
										choose(normalizeHexColor(event.currentTarget.value))
									}
									onClick={(event) => {
										if (!user.isPro) {
											event.preventDefault();
											setShowUpgradeModal(true);
										}
									}}
									className="absolute inset-0 opacity-0 cursor-pointer"
								/>
								{customSelected ? (
									<Check
										className="size-4"
										strokeWidth={3}
										style={{ color: brand?.foreground }}
									/>
								) : (
									<Pipette className="size-3.5 text-gray-10" />
								)}
							</label>
						</fieldset>

						<div className="flex gap-2 items-center">
							<label
								htmlFor={hexInputId}
								className="text-[13px] font-medium text-gray-11"
							>
								Hex
							</label>
							<input
								id={hexInputId}
								value={hexText}
								placeholder={CAP_PLAY_BLUE}
								maxLength={7}
								spellCheck={false}
								autoComplete="off"
								disabled={save.isPending}
								aria-invalid={!hexValid}
								aria-describedby={noteId}
								onFocus={() => {
									if (!user.isPro) setShowUpgradeModal(true);
								}}
								onChange={(event) => {
									const next = event.currentTarget.value.trim();
									setHexText(next);
									if (next === "") {
										setDraft(null);
										return;
									}
									const parsed = normalizeHexColor(next);
									if (parsed && user.isPro) setDraft(parsed);
								}}
								className={clsx(
									"px-2.5 w-28 h-9 font-mono text-[13px] uppercase rounded-lg border outline-none bg-gray-1 text-gray-12 placeholder:text-gray-8 focus:ring-2 focus:ring-blue-9/30",
									hexValid
										? "border-gray-4 focus:border-blue-8"
										: "border-red-500 focus:border-red-500",
								)}
							/>
						</div>

						<p
							id={noteId}
							className="min-h-[2.5rem] text-[13px] leading-5 text-gray-10"
						>
							{!hexValid
								? "Use a six digit hex color, like #1F6FEB."
								: brand && !brand.accent
									? "This color is too dark to see on video, so the progress bar and focus rings stay white. The play button uses it."
									: brand
										? `The play icon is ${brand.foreground === "#FFFFFF" ? "white" : "dark"} on this color so it stays readable.`
										: "Share pages and embeds use Cap blue."}
						</p>

						{dirty && (
							<div className="flex gap-2 items-center">
								<button
									type="button"
									disabled={save.isPending || !hexValid}
									onClick={() => save.mutate(draft)}
									className="inline-flex gap-1.5 items-center px-4 h-9 text-[13px] font-semibold rounded-full transition-[opacity,transform] bg-gray-12 text-gray-1 hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
								>
									{save.isPending ? "Saving…" : "Save"}
								</button>
								<button
									type="button"
									disabled={save.isPending}
									onClick={() => {
										setDraft(savedColor);
										setHexText(savedColor ?? "");
									}}
									className="px-4 h-9 text-[13px] font-medium rounded-full transition-colors text-gray-11 hover:bg-gray-3 hover:text-gray-12 disabled:opacity-50"
								>
									Cancel
								</button>
							</div>
						)}
					</div>

					<PlayerPreview color={draft} />
				</div>
			</SettingsRow>
			<UpgradeModal
				open={showUpgradeModal}
				onOpenChange={setShowUpgradeModal}
			/>
		</>
	);
};

function Swatch({
	label,
	color,
	selected,
	disabled,
	onSelect,
}: {
	label: string;
	color: string;
	selected: boolean;
	disabled: boolean;
	onSelect: () => void;
}) {
	const foreground = resolvePlayerBrand(color)?.foreground;
	return (
		<label
			title={label}
			className={clsx(
				"flex justify-center items-center rounded-full transition-transform cursor-pointer size-8 hover:scale-105 focus-within:ring-2 focus-within:ring-blue-9 focus-within:ring-offset-2 focus-within:ring-offset-gray-1 has-[:disabled]:opacity-60",
				selected && "ring-2 ring-gray-12 ring-offset-2 ring-offset-gray-1",
			)}
			style={{ background: color }}
		>
			<input
				type="radio"
				name="brand-color"
				aria-label={label}
				checked={selected}
				disabled={disabled}
				onChange={onSelect}
				className="sr-only"
			/>
			{selected && (
				<Check
					className="size-4"
					strokeWidth={3}
					style={{ color: foreground }}
					aria-hidden
				/>
			)}
		</label>
	);
}

function PlayerPreview({ color }: { color: string | null }) {
	const attributes = playerBrandAttributes(resolvePlayerBrand(color));
	return (
		<div
			{...attributes}
			aria-hidden
			className="overflow-hidden relative w-full rounded-xl border shadow-sm aspect-video shrink-0 border-gray-4 bg-[linear-gradient(135deg,#2a2f3a_0%,#14161c_55%,#0b0c10_100%)] md:w-[280px]"
		>
			<div className="flex absolute inset-0 justify-center items-center">
				<div className="flex justify-center items-center bg-blue-500 rounded-full transition-colors player-brand-play size-14">
					<FontAwesomeIcon icon={faPlay} className="text-white size-5" />
				</div>
			</div>
			<div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t to-transparent from-black/70" />
			<div className="flex absolute inset-x-3 bottom-3 flex-col gap-2">
				<div className="flex relative items-center h-3">
					<div className="overflow-hidden relative w-full h-1 rounded-full bg-white/40">
						<div className="absolute h-full bg-white player-brand-range w-[38%]" />
					</div>
					<div className="absolute left-[38%] -translate-x-1/2 bg-white rounded-full shadow-sm player-brand-thumb size-3" />
				</div>
				<span className="text-[10px] font-medium tabular-nums text-white/80">
					0:42 / 1:52
				</span>
			</div>
		</div>
	);
}
