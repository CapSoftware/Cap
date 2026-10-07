"use client";

import clsx from "clsx";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import {
	type CSSProperties,
	type FormEvent,
	startTransition,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { trackEvent } from "@/app/utils/analytics";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { splitFullName } from "../onboarding-flow";
import { StepLede, StepPage, StepTitle } from "./StepChrome";
import { WaveDoodle } from "./scenes";

const NamePreview = ({ name }: { name: string }) => {
	const trimmed = name.trim();
	const initial = trimmed.charAt(0).toUpperCase();

	return (
		<div className="relative mx-auto w-full max-w-[420px] pt-14 lg:pt-16">
			<div className="pointer-events-none absolute left-2 top-0 flex items-start gap-1 sm:left-6">
				<p className="ob-fade max-w-[200px] -rotate-3 text-[15px] italic leading-snug text-[var(--ob-ink-soft)]">
					This is how you'll show up when you share
				</p>
				<svg
					viewBox="0 0 60 64"
					className="ob-boil mt-3 h-14 w-12 shrink-0 overflow-visible"
					aria-hidden="true"
				>
					<path
						pathLength={1}
						className="ob-ink ob-draw"
						style={{ "--d": "0.5s" } as CSSProperties}
						d="M 4 6 C 30 4 46 22 44 56"
					/>
					<path
						pathLength={1}
						className="ob-ink ob-draw"
						style={{ "--d": "1.15s" } as CSSProperties}
						d="M 34 46 L 44 58 L 53 45"
					/>
				</svg>
			</div>
			<div className="ob-card ob-rise -rotate-[1.2deg] p-2.5 shadow-[0_30px_60px_-40px_rgba(32,36,44,0.45)]">
				<div className="ob-scene-frame relative aspect-video overflow-hidden">
					<svg
						viewBox="0 0 320 180"
						className="absolute inset-0 size-full"
						aria-hidden="true"
					>
						<rect x="28" y="30" width="120" height="10" rx="5" fill="#e4e1d9" />
						<rect
							x="28"
							y="52"
							width="170"
							height="7"
							rx="3.5"
							fill="#ebe8e1"
						/>
						<rect
							x="28"
							y="66"
							width="140"
							height="7"
							rx="3.5"
							fill="#ebe8e1"
						/>
						<rect
							x="28"
							y="80"
							width="156"
							height="7"
							rx="3.5"
							fill="#ebe8e1"
						/>
						<g className="ob-boil">
							<rect
								x="210"
								y="30"
								width="82"
								height="64"
								rx="8"
								className="ob-ink is-track"
							/>
							<path
								d="M 218 84 L 232 68 L 244 76 L 262 50 L 284 60"
								className="ob-ink is-accent"
							/>
							<circle
								cx="160"
								cy="122"
								r="22"
								className="ob-ink"
								style={{ fill: "rgba(255,255,255,0.9)" }}
							/>
						</g>
						<path d="M 153 111 L 172 122 L 153 133 Z" fill="var(--ob-ink)" />
						<circle
							cx="282"
							cy="146"
							r="20"
							fill="color-mix(in srgb, var(--ob-camera) 20%, #fff)"
							stroke="var(--ob-camera)"
							strokeWidth="2"
						/>
						<text
							x="282"
							y="152"
							fontSize="16"
							fontWeight="500"
							textAnchor="middle"
							fill="var(--ob-camera)"
						>
							{initial || "?"}
						</text>
					</svg>
				</div>
				<div className="flex items-center gap-3 px-2 pb-2 pt-3.5">
					<span
						className={clsx(
							"flex size-10 shrink-0 items-center justify-center rounded-full text-[16px] font-medium transition-colors",
							initial
								? "bg-[var(--ob-accent)] text-white"
								: "bg-[var(--ob-paper-2)] text-[var(--ob-ink-faint)]",
						)}
					>
						{initial || "?"}
					</span>
					<div className="min-w-0">
						<p
							className={clsx(
								"truncate text-[16px] font-medium",
								trimmed ? "text-[var(--ob-ink)]" : "text-[var(--ob-ink-faint)]",
							)}
						>
							{trimmed || "Your name"}
						</p>
						<p className="truncate text-[13.5px] text-[var(--ob-ink-soft)]">
							shared a video with you · just now
						</p>
					</div>
				</div>
			</div>
		</div>
	);
};

export const WelcomeStep = ({
	organizationName,
	nextHref,
}: {
	organizationName: string | null;
	nextHref: string;
}) => {
	const router = useRouter();
	const rpc = useRpcClient();
	const inputId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const [name, setName] = useState("");

	useEffect(() => {
		inputRef.current?.focus();
	}, []);
	const ready = name.trim().length > 0;

	const welcome = useEffectMutation({
		mutationFn: (data: { firstName: string; lastName?: string }) =>
			rpc.UserCompleteOnboardingStep({ step: "welcome", data }),
		onSuccess: () => {
			trackEvent("onboarding_name_saved");
			startTransition(() => {
				router.push(nextHref);
				router.refresh();
			});
		},
		onError: () => {
			toast.error("We couldn't save your name. Please try again.");
		},
	});

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!ready || welcome.isPending || welcome.isSuccess) return;
		const { firstName, lastName } = splitFullName(name);
		welcome.mutate({ firstName, lastName: lastName || undefined });
	};

	const busy = welcome.isPending || welcome.isSuccess;

	return (
		<StepPage>
			<div className="grid flex-1 items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
				<div className="flex flex-col">
					<div className="ob-rise -ml-2 mb-3">
						<WaveDoodle />
					</div>
					<StepTitle>
						{organizationName ? (
							<>
								Welcome to{" "}
								<span className="break-words">{organizationName}</span>
							</>
						) : (
							"Welcome to Cap"
						)}
					</StepTitle>
					<StepLede>
						{organizationName
							? "You're one step away from your team's videos. What should we call you?"
							: "Let's get your first video out the door. First, what should we call you?"}
					</StepLede>
					<form
						onSubmit={submit}
						className="ob-rise mt-8 flex max-w-[480px] flex-col gap-3"
						style={{ "--d": "0.12s" } as CSSProperties}
					>
						<label
							htmlFor={inputId}
							className="text-[14px] font-medium text-[var(--ob-ink-2)]"
						>
							Your name
						</label>
						<input
							id={inputId}
							className="ob-input"
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="Ada Lovelace"
							autoComplete="name"
							autoCapitalize="words"
							enterKeyHint="go"
							maxLength={120}
							disabled={busy}
							required
							ref={inputRef}
						/>
						<button
							type="submit"
							className="ob-cta mt-2 w-full sm:w-fit"
							disabled={!ready || busy}
						>
							{busy ? "Saving…" : "Continue"}
							<ArrowRight className="ob-cta-arrow size-4" aria-hidden />
						</button>
						<p className="mt-1 text-[13px] text-[var(--ob-ink-soft)]">
							You can change this any time in settings.
						</p>
					</form>
				</div>
				<NamePreview name={name} />
			</div>
		</StepPage>
	);
};
