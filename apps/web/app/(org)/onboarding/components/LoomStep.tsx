"use client";

import type { Organisation } from "@cap/web-domain";
import clsx from "clsx";
import { ArrowRight, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
	type CSSProperties,
	type FormEvent,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { importFromLoom } from "@/actions/loom";
import { trackEvent } from "@/app/utils/analytics";
import { UpgradeModal } from "@/components/UpgradeModal";
import { isLoomShareUrl } from "@/lib/loom-import-href";
import { onboardingStepHref } from "../onboarding-flow";
import { Explainer, LOOM_MARK_PATH, LoomMark } from "./paper";
import { BackLink, ProNote, StepLede, StepPage, StepTitle } from "./StepChrome";
import { DoneDoodle, LoomScene } from "./scenes";
import { useGetStarted } from "./use-get-started";
import { useUpgradeConfirmation } from "./use-upgrade-confirmation";

const CsvGlyph = () => (
	<span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-[var(--ob-paper-2)]">
		<svg
			viewBox="0 0 28 28"
			className="ob-boil size-6 overflow-visible"
			aria-hidden="true"
		>
			<rect x="3.5" y="4.5" width="21" height="19" rx="3" className="ob-ink" />
			<path
				d="M 3.5 10.5 L 24.5 10.5 M 3.5 16.5 L 24.5 16.5 M 11 4.5 L 11 23.5"
				className="ob-ink"
				style={{ strokeWidth: 1.6 }}
			/>
			<path
				d={LOOM_MARK_PATH}
				transform="translate(14.2 12) scale(0.36)"
				fill="var(--ob-loom)"
			/>
		</svg>
	</span>
);

const LoomToCapBadge = () => (
	<div className="ob-rise mb-5 flex items-center gap-2">
		<span className="flex size-11 items-center justify-center rounded-2xl border-[1.5px] border-[var(--ob-track)] bg-[var(--ob-surface)]">
			<LoomMark size={22} />
		</span>
		<svg
			viewBox="0 0 44 20"
			className="ob-boil h-5 w-11 overflow-visible"
			aria-hidden="true"
		>
			<path
				pathLength={1}
				className="ob-ink ob-draw"
				style={{ "--d": "0.2s" } as CSSProperties}
				d="M 3 12 C 14 4 26 4 38 10"
			/>
			<path
				pathLength={1}
				className="ob-ink ob-draw"
				style={{ "--d": "0.7s" } as CSSProperties}
				d="M 31 5 L 39 10.5 L 31 15"
			/>
		</svg>
		<span className="flex size-11 items-center justify-center rounded-2xl border-[1.5px] border-[var(--ob-track)] bg-[var(--ob-surface)]">
			<svg viewBox="0 0 40 40" className="size-6" aria-hidden="true">
				<circle cx="20" cy="20" r="16" fill="#4785FF" />
				<circle cx="20" cy="20" r="13" fill="#ADC9FF" />
				<circle cx="20" cy="20" r="10" fill="#fff" />
			</svg>
		</span>
	</div>
);

export const LoomStep = ({
	organizationId,
	initialUrl,
	bulk,
	canBulkImport,
	isPro,
	justUpgraded,
	completed,
}: {
	organizationId: Organisation.OrganisationId | null;
	initialUrl: string;
	bulk: boolean;
	canBulkImport: boolean;
	isPro: boolean;
	justUpgraded: boolean;
	completed: boolean;
}) => {
	const router = useRouter();
	const inputId = useId();
	const messageId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const { complete } = useGetStarted(completed, "loom");
	const [url, setUrl] = useState(initialUrl);
	const [touched, setTouched] = useState(Boolean(initialUrl));
	const [status, setStatus] = useState<"idle" | "importing" | "done">("idle");
	const [upgradeOpen, setUpgradeOpen] = useState(false);
	const [leaving, setLeaving] = useState(false);
	const upgrade = useUpgradeConfirmation({ justUpgraded, isPro });

	const trimmed = url.trim();
	const valid = isLoomShareUrl(trimmed);
	const showError = touched && trimmed.length > 0 && !valid;

	useEffect(() => {
		if (organizationId) return;
		complete("loom")
			.then(() => router.refresh())
			.catch(() => undefined);
	}, [organizationId, complete, router]);

	useEffect(() => {
		if (!initialUrl) inputRef.current?.focus();
	}, [initialUrl]);

	const leaveTo = async (href: string) => {
		setLeaving(true);
		try {
			await complete("loom");
			router.push(href);
		} catch {
			setLeaving(false);
			toast.error("Something went wrong. Please try again.");
		}
	};

	const submit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setTouched(true);
		if (!valid) {
			inputRef.current?.focus();
			return;
		}
		if (!isPro) {
			trackEvent("onboarding_loom_upgrade_prompted");
			setUpgradeOpen(true);
			return;
		}
		if (!organizationId) {
			toast.info("Your library is still being set up. Try again in a second.");
			router.refresh();
			return;
		}

		setStatus("importing");
		try {
			await complete("loom").catch(() => undefined);
			const result = await importFromLoom({
				loomUrl: trimmed,
				orgId: organizationId,
			});
			if (!result?.success) {
				toast.error(result?.error || "We couldn't import that video.");
				setStatus("idle");
				return;
			}
			trackEvent("onboarding_loom_imported");
			setStatus("done");
		} catch {
			toast.error("Something went wrong. Please try again.");
			setStatus("idle");
		}
	};

	const importing = status === "importing";

	return (
		<StepPage>
			<BackLink />
			<div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-14">
				<div className="flex min-w-0 flex-col">
					<LoomToCapBadge />
					<StepTitle>Bring your Looms to Cap</StepTitle>
					<StepLede>
						Paste a Loom share link and we'll copy the video into your Cap
						library, or bring your whole library over with a CSV. Your Looms
						stay exactly where they are.
					</StepLede>

					{status === "done" ? (
						<div className="ob-card ob-rise mt-8 flex flex-col items-start p-6 sm:p-7">
							<DoneDoodle />
							<h2 className="mt-3 text-[22px] font-medium tracking-[-0.01em]">
								Your Loom is on its way
							</h2>
							<p className="mt-1.5 text-[15px] leading-relaxed text-[var(--ob-ink-soft)]">
								We're copying it into My Caps now. It usually takes a minute or
								two, and it keeps going if you leave this page.
							</p>
							<div className="mt-6 flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
								<button
									type="button"
									className="ob-cta"
									disabled={leaving}
									onClick={() => leaveTo("/dashboard/caps")}
								>
									Go to my Caps
									<ArrowRight className="ob-cta-arrow size-4" aria-hidden />
								</button>
								<button
									type="button"
									className="ob-cta is-quiet"
									onClick={() => {
										setUrl("");
										setTouched(false);
										setStatus("idle");
										requestAnimationFrame(() => inputRef.current?.focus());
									}}
								>
									Import another
								</button>
							</div>
						</div>
					) : (
						<form
							noValidate
							onSubmit={submit}
							className="ob-rise mt-8 flex flex-col gap-3"
							style={{ "--d": "0.12s" } as CSSProperties}
						>
							<label
								htmlFor={inputId}
								className="text-[14px] font-medium text-[var(--ob-ink-2)]"
							>
								Loom share link
							</label>
							<div className="relative">
								<LoomMark
									size={20}
									className="pointer-events-none absolute left-[18px] top-1/2 -translate-y-1/2"
								/>
								<input
									ref={inputRef}
									id={inputId}
									type="url"
									inputMode="url"
									autoComplete="off"
									spellCheck={false}
									enterKeyHint="go"
									className="ob-input !pl-12 !pr-12"
									placeholder="https://www.loom.com/share/…"
									value={url}
									disabled={importing}
									onChange={(event) => setUrl(event.target.value)}
									onBlur={() => setTouched(true)}
									onPaste={() => setTouched(true)}
									aria-invalid={showError}
									aria-describedby={messageId}
								/>
								{valid && (
									<svg
										viewBox="0 0 24 24"
										className="pointer-events-none absolute right-4 top-1/2 size-6 -translate-y-1/2 overflow-visible"
										aria-hidden="true"
									>
										<path
											pathLength={1}
											className="ob-ink is-green is-bold ob-draw"
											style={{ "--d": "0s" } as CSSProperties}
											d="M 5 12.5 L 10 17 L 19 7"
										/>
									</svg>
								)}
							</div>
							<p
								id={messageId}
								role={showError ? "alert" : undefined}
								className={
									showError
										? "text-[13.5px] leading-relaxed text-[var(--ob-red)]"
										: "text-[13.5px] leading-relaxed text-[var(--ob-ink-soft)]"
								}
							>
								{showError
									? "That doesn't look like a Loom share link. It should start with loom.com/share/."
									: valid
										? "Looks good. Press import and we'll take it from here."
										: "On any Loom video, press Share, then Copy link."}
							</p>
							<div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center">
								<button
									type="submit"
									className="ob-cta"
									disabled={importing || upgrade.waiting}
								>
									{importing ? (
										<>
											<LoaderCircle
												className="size-4 animate-spin"
												aria-hidden
											/>
											Starting your import…
										</>
									) : (
										<>
											{isPro ? "Import video" : "Import with Cap Pro"}
											<ArrowRight className="ob-cta-arrow size-4" aria-hidden />
										</>
									)}
								</button>
							</div>
							{upgrade.waiting ? (
								<ProNote className="mt-3">
									<span className="inline-flex items-center gap-2">
										<LoaderCircle
											className="size-3.5 animate-spin"
											aria-hidden
										/>
										Finishing your upgrade. This only takes a moment.
									</span>
								</ProNote>
							) : upgrade.timedOut ? (
								<ProNote className="mt-3">
									Your upgrade is taking a little longer than usual. Refresh
									this page in a moment and your import will be ready to go.
								</ProNote>
							) : (
								!isPro && (
									<ProNote className="mt-3">
										Moving from Loom is part of Cap Pro, so you can bring over
										as many videos as you like.{" "}
										<Link
											href={onboardingStepHref("record")}
											className="ob-link !inline !text-[14px]"
										>
											Or record something new for free
										</Link>
									</ProNote>
								)
							)}
						</form>
					)}

					{status !== "done" && (
						<div
							className={clsx(
								"ob-card ob-rise mt-6 flex items-start gap-4 p-5 sm:p-6",
								bulk && "!border-[var(--ob-ink)]",
							)}
							style={{ "--d": "0.2s" } as CSSProperties}
						>
							<CsvGlyph />
							<div className="flex min-w-0 flex-col">
								<h2 className="text-[16px] font-medium tracking-[-0.01em]">
									Moving lots of videos?
								</h2>
								<p className="mt-1 text-[14px] leading-relaxed text-[var(--ob-ink-soft)]">
									Add your Loom links to a spreadsheet and import up to 500 at a
									time. We'll give you a template, and each video can go to the
									right person and space.
								</p>
								{canBulkImport ? (
									<button
										type="button"
										className="ob-cta is-quiet is-small mt-4 w-full sm:w-fit"
										disabled={leaving}
										onClick={() => leaveTo("/dashboard/import/loom?mode=csv")}
									>
										Bulk import from a CSV
										<ArrowRight className="ob-cta-arrow size-4" aria-hidden />
									</button>
								) : (
									<p className="mt-2 text-[13.5px] text-[var(--ob-ink-2)]">
										Ask an admin on your team to run a bulk import.
									</p>
								)}
							</div>
						</div>
					)}
				</div>

				<Explainer
					className="ob-rise lg:sticky lg:top-8"
					label="How moving from Loom works"
					loopSeconds={9}
					scene={<LoomScene />}
					steps={[
						{
							title: "Copy the link from Loom",
							body: "Open any Loom video, press Share, then Copy link.",
						},
						{
							title: "Paste it here and press Import",
							body: "We check the link as soon as you paste it.",
						},
						{
							title: "Find it in your Cap library",
							body: "Same video with a Cap link you can share. Nothing changes on Loom.",
						},
					]}
				/>
			</div>
			<UpgradeModal
				open={upgradeOpen}
				onOpenChange={setUpgradeOpen}
				returnPath={onboardingStepHref("loom", { url: trimmed || undefined })}
			/>
		</StepPage>
	);
};
