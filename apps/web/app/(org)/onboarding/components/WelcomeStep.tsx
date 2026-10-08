"use client";

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
import { SharePreview } from "./SharePreview";
import { StepLede, StepPage, StepTitle } from "./StepChrome";

const WavingHand = () => (
	<span className="relative inline-block whitespace-nowrap">
		<span role="img" aria-label="Waving hand" className="ob-wave">
			👋
		</span>
		<svg
			viewBox="0 0 24 24"
			className="ob-boil pointer-events-none absolute -right-[0.42em] -top-[0.32em] size-[0.6em] overflow-visible"
			aria-hidden="true"
		>
			<path
				pathLength={1}
				className="ob-ink is-accent ob-draw"
				style={{ "--d": "0.55s", strokeWidth: 2.4 } as CSSProperties}
				d="M 5 13 C 8 10 10 7 11 3"
			/>
			<path
				pathLength={1}
				className="ob-ink is-accent ob-draw"
				style={{ "--d": "0.75s", strokeWidth: 2.4 } as CSSProperties}
				d="M 11 19 C 15 17 18 14 20 10"
			/>
		</svg>
	</span>
);

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
					<StepTitle className="ob-greeting">
						Hey, welcome to{" "}
						<span className="break-words">
							{organizationName ?? "Cap"}
							{"\u00a0"}
							<WavingHand />
						</span>
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
				<SharePreview name={name} />
			</div>
		</StepPage>
	);
};
