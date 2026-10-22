"use client";

import { Dialog, DialogContent, DialogTitle, Switch } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import clsx from "clsx";
import { Check, Link2, MousePointer2, Pipette, Play, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
	type ReactNode,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { updateVideoCallToAction } from "@/actions/videos/call-to-action";
import {
	type CallToActionErrors,
	CTA_COLOR_PRESETS,
	CTA_HEADLINE_MAX_LENGTH,
	CTA_LABEL_MAX_LENGTH,
	CTA_LABEL_SUGGESTIONS,
	DEFAULT_CTA_COLOR,
	normalizeCallToActionUrl,
	normalizeHexColor,
	type ShareCallToAction,
	validateCallToAction,
} from "@/lib/share-call-to-action";
import {
	CallToActionCornerCard,
	CallToActionEndScreen,
} from "./CallToActionSurfaces";

type PreviewMode = "end" | "playing";

type FormState = {
	label: string;
	url: string;
	headline: string;
	color: string;
	showWhilePlaying: boolean;
};

const EMPTY_FORM: FormState = {
	label: "",
	url: "",
	headline: "",
	color: DEFAULT_CTA_COLOR,
	showWhilePlaying: true,
};

const PREVIEW_PLACEHOLDER_LABEL = "Book a call";

function formFromCallToAction(cta: ShareCallToAction | null): FormState {
	if (!cta) return EMPTY_FORM;
	return {
		label: cta.label,
		url: cta.url,
		headline: cta.headline ?? "",
		color: cta.color,
		showWhilePlaying: cta.showWhilePlaying,
	};
}

function useVideoThumbnail(videoId: Video.VideoId, enabled: boolean) {
	const [thumbnail, setThumbnail] = useState<string | null>(null);

	useEffect(() => {
		if (!enabled) return;
		const controller = new AbortController();
		fetch(`/api/thumbnail?videoId=${encodeURIComponent(videoId)}`, {
			signal: controller.signal,
		})
			.then((response) => (response.ok ? response.json() : null))
			.then((body: unknown) => {
				if (
					body &&
					typeof body === "object" &&
					"screen" in body &&
					typeof body.screen === "string"
				) {
					setThumbnail(body.screen);
				}
			})
			.catch(() => {});
		return () => controller.abort();
	}, [enabled, videoId]);

	return thumbnail;
}

export function CallToActionDialog({
	open,
	onOpenChange,
	videoId,
	callToAction,
	onSaved,
	onUpgradeRequest,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	videoId: Video.VideoId;
	callToAction: ShareCallToAction | null;
	onSaved?: (callToAction: ShareCallToAction | null) => void;
	onUpgradeRequest: () => void;
}) {
	const [form, setForm] = useState<FormState>(() =>
		formFromCallToAction(callToAction),
	);
	const [errors, setErrors] = useState<CallToActionErrors>({});
	const [touched, setTouched] = useState<Record<string, boolean>>({});
	const [previewMode, setPreviewMode] = useState<PreviewMode>("end");
	const [pending, setPending] = useState<"save" | "remove" | null>(null);
	const labelInputRef = useRef<HTMLInputElement>(null);
	const thumbnail = useVideoThumbnail(videoId, open);
	const ids = {
		label: useId(),
		url: useId(),
		headline: useId(),
		playing: useId(),
		form: useId(),
	};

	const wasOpenRef = useRef(false);
	useEffect(() => {
		const opening = open && !wasOpenRef.current;
		wasOpenRef.current = open;
		if (!opening) return;
		setForm(formFromCallToAction(callToAction));
		setErrors({});
		setTouched({});
		setPreviewMode("end");
		setPending(null);
	}, [open, callToAction]);

	const liveErrors = useMemo(() => {
		const result = validateCallToAction(form);
		return result.ok ? {} : result.errors;
	}, [form]);

	const visibleError = (field: keyof CallToActionErrors) =>
		errors[field] ?? (touched[field] ? liveErrors[field] : undefined);

	const previewCta: ShareCallToAction = {
		label: form.label.trim() || PREVIEW_PLACEHOLDER_LABEL,
		url: normalizeCallToActionUrl(form.url) ?? "https://cap.so",
		headline: form.headline.trim() || null,
		color: normalizeHexColor(form.color) ?? DEFAULT_CTA_COLOR,
		showWhilePlaying: form.showWhilePlaying,
	};

	const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
		setForm((previous) => ({ ...previous, [key]: value }));
		if (key in errors) {
			setErrors((previous) => ({ ...previous, [key]: undefined }));
		}
	};

	const markTouched = (field: string) =>
		setTouched((previous) => ({ ...previous, [field]: true }));

	const isEditing = callToAction !== null;
	const busy = pending !== null;

	const handleSave = async () => {
		const result = validateCallToAction(form);
		if (!result.ok) {
			setErrors(result.errors);
			setTouched({ label: true, url: true, headline: true });
			return;
		}
		setPending("save");
		try {
			const response = await updateVideoCallToAction(videoId, form);
			if (!response.success) {
				if (response.upgradeRequired) {
					onOpenChange(false);
					onUpgradeRequest();
					return;
				}
				setErrors(response.errors);
				return;
			}
			toast.success(
				isEditing ? "Call to action updated" : "Call to action added",
			);
			onSaved?.(response.callToAction);
			onOpenChange(false);
		} catch {
			toast.error("Couldn't save your call to action");
		} finally {
			setPending(null);
		}
	};

	const handleRemove = async () => {
		setPending("remove");
		try {
			const response = await updateVideoCallToAction(videoId, null);
			if (!response.success) {
				if (response.upgradeRequired) {
					onOpenChange(false);
					onUpgradeRequest();
				} else {
					toast.error("Couldn't remove your call to action");
				}
				return;
			}
			toast.success("Call to action removed");
			onSaved?.(null);
			onOpenChange(false);
		} catch {
			toast.error("Couldn't remove your call to action");
		} finally {
			setPending(null);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
			<DialogContent
				hideCloseButton
				aria-describedby={undefined}
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					labelInputRef.current?.focus();
				}}
				className="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[920px] flex-col overflow-hidden rounded-2xl border border-gray-4 bg-gray-1 md:flex-row"
			>
				<section className="relative flex shrink-0 flex-col gap-4 border-b border-gray-4 bg-gray-2 p-5 md:w-[54%] md:border-b-0 md:border-r md:p-6">
					<div className="flex items-center justify-between gap-3">
						<p className="text-xs font-medium text-gray-10">Preview</p>
						<div
							role="tablist"
							aria-label="Preview"
							className="flex items-center gap-0.5 rounded-full border border-gray-4 bg-gray-1 p-0.5"
						>
							{(
								[
									{ id: "end", label: "End of video" },
									{ id: "playing", label: "While playing" },
								] as const
							).map((mode) => (
								<button
									key={mode.id}
									type="button"
									role="tab"
									aria-selected={previewMode === mode.id}
									onClick={() => setPreviewMode(mode.id)}
									className={clsx(
										"relative rounded-full px-3 py-1 text-xs font-medium transition-colors",
										previewMode === mode.id
											? "text-gray-12"
											: "text-gray-10 hover:text-gray-12",
									)}
								>
									{previewMode === mode.id && (
										<motion.span
											layoutId="cta-preview-mode"
											className="absolute inset-0 rounded-full bg-gray-4"
											transition={{
												type: "spring",
												stiffness: 500,
												damping: 38,
											}}
										/>
									)}
									<span className="relative">{mode.label}</span>
								</button>
							))}
						</div>
					</div>

					<div className="flex flex-1 flex-col justify-center gap-4">
						<PreviewStage
							cta={previewCta}
							mode={previewMode}
							thumbnail={thumbnail}
							onEnableWhilePlaying={() => update("showWhilePlaying", true)}
						/>

						<p className="min-h-[2.5rem] text-[13px] leading-relaxed text-gray-10">
							{previewMode === "end"
								? "Shown over the last frame when your video finishes. Viewers can click through or replay."
								: form.showWhilePlaying
									? "Slides into the corner a few seconds in, on screens wide enough to fit it. Viewers can close it."
									: "Only the end screen is on. Turn on “Show while playing” to add the corner card."}
						</p>
					</div>
				</section>

				<section className="flex min-h-0 flex-1 flex-col">
					<header className="flex items-start gap-3 px-6 pb-4 pt-6">
						<span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-blue-3 text-blue-11">
							<MousePointer2 className="size-[18px]" strokeWidth={2} />
						</span>
						<div className="min-w-0 flex-1">
							<DialogTitle className="text-lg font-semibold leading-tight text-gray-12">
								Call to action
							</DialogTitle>
							<p className="mt-0.5 text-[13px] text-gray-10">
								Give viewers a next step, right on your video.
							</p>
						</div>
						<button
							type="button"
							onClick={() => onOpenChange(false)}
							disabled={busy}
							aria-label="Close"
							className="-mr-1 rounded-lg p-1 text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9"
						>
							<X className="size-5" />
						</button>
					</header>

					<form
						id={ids.form}
						className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-6"
						onSubmit={(event) => {
							event.preventDefault();
							void handleSave();
						}}
					>
						<Field
							id={ids.label}
							label="Button text"
							error={visibleError("label")}
							counter={
								form.label.length > CTA_LABEL_MAX_LENGTH - 10
									? `${form.label.length}/${CTA_LABEL_MAX_LENGTH}`
									: undefined
							}
						>
							<TextInput
								ref={labelInputRef}
								id={ids.label}
								value={form.label}
								placeholder="Book a call"
								maxLength={CTA_LABEL_MAX_LENGTH + 10}
								invalid={Boolean(visibleError("label"))}
								onChange={(value) => update("label", value)}
								onBlur={() => form.label && markTouched("label")}
							/>
							<div className="flex flex-wrap gap-1.5 pt-0.5">
								{CTA_LABEL_SUGGESTIONS.map((suggestion) => (
									<button
										key={suggestion}
										type="button"
										onClick={() => update("label", suggestion)}
										className={clsx(
											"rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9",
											form.label === suggestion
												? "border-blue-7 bg-blue-3 text-blue-11"
												: "border-gray-4 bg-gray-1 text-gray-11 hover:border-gray-6 hover:bg-gray-3 hover:text-gray-12",
										)}
									>
										{suggestion}
									</button>
								))}
							</div>
						</Field>

						<Field id={ids.url} label="Link" error={visibleError("url")}>
							<TextInput
								id={ids.url}
								value={form.url}
								placeholder="cal.com/you"
								inputMode="url"
								autoComplete="url"
								spellCheck={false}
								icon={<Link2 className="size-4" />}
								invalid={Boolean(visibleError("url"))}
								onChange={(value) => update("url", value)}
								onBlur={() => {
									if (!form.url.trim()) return;
									markTouched("url");
									const normalized = normalizeCallToActionUrl(form.url);
									if (normalized) update("url", normalized);
								}}
							/>
						</Field>

						<Field
							id={ids.headline}
							label="Headline"
							optional
							error={visibleError("headline")}
							counter={
								form.headline.length > CTA_HEADLINE_MAX_LENGTH - 15
									? `${form.headline.length}/${CTA_HEADLINE_MAX_LENGTH}`
									: undefined
							}
						>
							<TextInput
								id={ids.headline}
								value={form.headline}
								placeholder="Want to see it in action?"
								maxLength={CTA_HEADLINE_MAX_LENGTH + 20}
								invalid={Boolean(visibleError("headline"))}
								onChange={(value) => update("headline", value)}
								onBlur={() => markTouched("headline")}
							/>
						</Field>

						<div className="flex flex-col gap-2">
							<p className="text-[13px] font-medium text-gray-12">
								Button color
							</p>
							<ColorPicker
								value={form.color}
								onChange={(color) => update("color", color)}
							/>
						</div>

						<label
							htmlFor={ids.playing}
							className="flex cursor-pointer items-start gap-4 rounded-xl border border-gray-4 bg-gray-2 p-4 transition-colors hover:border-gray-5"
							onPointerEnter={() => setPreviewMode("playing")}
						>
							<span className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="text-[13px] font-medium text-gray-12">
									Show while playing
								</span>
								<span className="text-xs leading-relaxed text-gray-10">
									A small card in the corner on larger screens. Viewers can
									close it.
								</span>
							</span>
							<Switch
								id={ids.playing}
								checked={form.showWhilePlaying}
								onCheckedChange={(checked) => {
									update("showWhilePlaying", checked);
									setPreviewMode("playing");
								}}
							/>
						</label>
					</form>

					<footer className="flex items-center gap-2 border-t border-gray-4 px-6 py-4">
						{isEditing && (
							<button
								type="button"
								onClick={() => void handleRemove()}
								disabled={busy}
								className="rounded-lg px-2 py-1.5 text-[13px] font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-500/10"
							>
								{pending === "remove" ? "Removing…" : "Remove"}
							</button>
						)}
						<div className="ml-auto flex items-center gap-2">
							<button
								type="button"
								onClick={() => onOpenChange(false)}
								disabled={busy}
								className="h-9 rounded-full px-4 text-[13px] font-medium text-gray-11 transition-colors hover:bg-gray-3 hover:text-gray-12 disabled:opacity-50"
							>
								Cancel
							</button>
							<button
								type="submit"
								form={ids.form}
								disabled={busy}
								className="inline-flex h-9 items-center gap-1.5 rounded-full bg-gray-12 px-4 text-[13px] font-semibold text-gray-1 transition-[opacity,transform] hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
							>
								{pending === "save"
									? "Saving…"
									: isEditing
										? "Save changes"
										: "Add to video"}
							</button>
						</div>
					</footer>
				</section>
			</DialogContent>
		</Dialog>
	);
}

function PreviewStage({
	cta,
	mode,
	thumbnail,
	onEnableWhilePlaying,
}: {
	cta: ShareCallToAction;
	mode: PreviewMode;
	thumbnail: string | null;
	onEnableWhilePlaying: () => void;
}) {
	return (
		<div
			className="relative aspect-video w-full overflow-hidden rounded-xl bg-[#0c0d10] shadow-[0_24px_48px_-24px_rgba(0,0,0,0.45)] ring-1 ring-black/5"
			aria-hidden
		>
			{thumbnail ? (
				<div
					className="absolute inset-0 bg-cover bg-center"
					style={{ backgroundImage: `url(${JSON.stringify(thumbnail)})` }}
				/>
			) : (
				<div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_20%_10%,#2a3140_0%,#12151b_55%,#0b0c0f_100%)]">
					<div className="absolute left-[8%] top-[12%] h-[8%] w-[34%] rounded-md bg-white/[0.07]" />
					<div className="absolute left-[8%] top-[26%] h-[5%] w-[52%] rounded-md bg-white/[0.05]" />
					<div className="absolute left-[8%] top-[35%] h-[5%] w-[44%] rounded-md bg-white/[0.05]" />
					<div className="absolute bottom-[14%] left-[8%] right-[8%] top-[48%] rounded-lg bg-white/[0.04]" />
				</div>
			)}

			<AnimatePresence mode="wait" initial={false}>
				{mode === "end" ? (
					<motion.div
						key="end"
						className="absolute inset-0"
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						transition={{ duration: 0.2 }}
					>
						<CallToActionEndScreen
							cta={cta}
							scale="regular"
							interactive={false}
							onReplay={() => {}}
						/>
					</motion.div>
				) : (
					<motion.div
						key="playing"
						className="absolute inset-0"
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						transition={{ duration: 0.2 }}
					>
						<div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/70 to-transparent" />
						<div className="absolute inset-x-3 bottom-3 flex flex-col gap-2">
							<div className="h-1 overflow-hidden rounded-full bg-white/25">
								<div className="h-full w-[38%] rounded-full bg-white" />
							</div>
							<div className="flex items-center gap-2 text-white">
								<Play className="size-3.5 fill-current" />
								<span className="text-[10px] font-medium tabular-nums text-white/80">
									0:42 / 1:52
								</span>
							</div>
						</div>
						<AnimatePresence>
							{cta.showWhilePlaying ? (
								<motion.div
									key="card"
									exit={{ opacity: 0, y: 6 }}
									transition={{ duration: 0.15 }}
									className="absolute bottom-12 right-3 origin-bottom-right scale-[0.82]"
								>
									<CallToActionCornerCard cta={cta} interactive={false} />
								</motion.div>
							) : (
								<motion.div
									key="off"
									initial={{ opacity: 0, y: 4 }}
									animate={{ opacity: 1, y: 0 }}
									exit={{ opacity: 0 }}
									className="pointer-events-auto absolute inset-0 flex items-center justify-center"
								>
									<button
										type="button"
										tabIndex={-1}
										onClick={onEnableWhilePlaying}
										className="rounded-full bg-black/55 px-3 py-1.5 text-xs font-medium text-white/85 backdrop-blur-md transition-colors hover:bg-black/70"
									>
										Corner card is off · Turn on
									</button>
								</motion.div>
							)}
						</AnimatePresence>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}

function Field({
	id,
	label,
	optional = false,
	error,
	counter,
	children,
}: {
	id: string;
	label: string;
	optional?: boolean;
	error?: string;
	counter?: string;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-baseline justify-between gap-2">
				<label htmlFor={id} className="text-[13px] font-medium text-gray-12">
					{label}
					{optional && (
						<span className="ml-1.5 font-normal text-gray-9">Optional</span>
					)}
				</label>
				{counter && (
					<span className="text-[11px] tabular-nums text-gray-9">
						{counter}
					</span>
				)}
			</div>
			{children}
			<AnimatePresence initial={false}>
				{error && (
					<motion.p
						key={error}
						initial={{ opacity: 0, height: 0 }}
						animate={{ opacity: 1, height: "auto" }}
						exit={{ opacity: 0, height: 0 }}
						transition={{ duration: 0.15 }}
						role="alert"
						className="text-xs text-red-600 dark:text-red-400"
					>
						{error}
					</motion.p>
				)}
			</AnimatePresence>
		</div>
	);
}

type TextInputProps = {
	id: string;
	value: string;
	placeholder?: string;
	maxLength?: number;
	invalid?: boolean;
	icon?: ReactNode;
	inputMode?: "url" | "text";
	autoComplete?: string;
	spellCheck?: boolean;
	onChange: (value: string) => void;
	onBlur?: () => void;
	ref?: React.Ref<HTMLInputElement>;
};

function TextInput({
	id,
	value,
	placeholder,
	maxLength,
	invalid = false,
	icon,
	inputMode,
	autoComplete = "off",
	spellCheck,
	onChange,
	onBlur,
	ref,
}: TextInputProps) {
	return (
		<div className="relative">
			{icon && (
				<span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-9">
					{icon}
				</span>
			)}
			<input
				ref={ref}
				id={id}
				type="text"
				value={value}
				placeholder={placeholder}
				maxLength={maxLength}
				inputMode={inputMode}
				autoComplete={autoComplete}
				spellCheck={spellCheck}
				aria-invalid={invalid || undefined}
				onChange={(event) => onChange(event.target.value)}
				onBlur={onBlur}
				className={clsx(
					"h-10 w-full rounded-xl border bg-gray-1 text-[14px] text-gray-12 outline-none transition-[border-color,box-shadow] placeholder:text-gray-8",
					icon ? "pl-9 pr-3" : "px-3",
					invalid
						? "border-red-400 focus:border-red-500 focus:shadow-[0_0_0_3px_rgba(239,68,68,0.15)]"
						: "border-gray-4 hover:border-gray-6 focus:border-blue-8 focus:shadow-[0_0_0_3px_rgba(47,107,255,0.15)]",
				)}
			/>
		</div>
	);
}

function ColorPicker({
	value,
	onChange,
}: {
	value: string;
	onChange: (color: string) => void;
}) {
	const normalized = normalizeHexColor(value) ?? DEFAULT_CTA_COLOR;
	const isCustom = !CTA_COLOR_PRESETS.some(
		(preset) => preset.value === normalized,
	);

	return (
		<div className="flex flex-wrap items-center gap-2">
			{CTA_COLOR_PRESETS.map((preset) => {
				const selected = preset.value === normalized;
				return (
					<button
						key={preset.value}
						type="button"
						aria-label={preset.name}
						aria-pressed={selected}
						title={preset.name}
						onClick={() => onChange(preset.value)}
						className={clsx(
							"relative flex size-8 items-center justify-center rounded-full transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-1",
							selected &&
								"ring-2 ring-gray-12 ring-offset-2 ring-offset-gray-1",
						)}
						style={{ background: preset.value }}
					>
						{selected && (
							<Check
								className="size-4 text-white drop-shadow"
								strokeWidth={3}
							/>
						)}
					</button>
				);
			})}
			<label
				title="Custom color"
				className={clsx(
					"relative flex size-8 cursor-pointer items-center justify-center rounded-full transition-transform hover:scale-105 focus-within:ring-2 focus-within:ring-blue-9 focus-within:ring-offset-2 focus-within:ring-offset-gray-1",
					isCustom && "ring-2 ring-gray-12 ring-offset-2 ring-offset-gray-1",
				)}
				style={{
					background: isCustom
						? normalized
						: "conic-gradient(from 180deg, #ff5f6d, #ffc371, #47e891, #3fa7ff, #a86bff, #ff5f6d)",
				}}
			>
				<span className="sr-only">Custom color</span>
				<Pipette
					className="size-3.5 text-white drop-shadow"
					strokeWidth={2.5}
				/>
				<input
					type="color"
					value={normalized.toLowerCase()}
					onChange={(event) =>
						onChange(normalizeHexColor(event.target.value) ?? normalized)
					}
					className="absolute inset-0 cursor-pointer opacity-0"
				/>
			</label>
			<span className="ml-1 font-mono text-xs uppercase text-gray-10">
				{normalized}
			</span>
		</div>
	);
}
