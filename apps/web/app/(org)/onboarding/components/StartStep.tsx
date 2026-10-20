"use client";

import type { User } from "@cap/web-domain";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { trackEvent } from "@/app/utils/analytics";
import { onboardingStepHref } from "../onboarding-flow";
import { StepLede, StepPage, StepTitle } from "./StepChrome";
import { LoomToCapDoodle, RecordDoodle, UploadDoodle } from "./scenes";
import { useGetStarted } from "./use-get-started";

type Choice = {
	path: "loom" | "record" | "upload";
	title: string;
	body: string;
	cue: string;
	doodle: ReactNode;
};

const CHOICES: readonly Choice[] = [
	{
		path: "loom",
		title: "Bring my videos from Loom",
		body: "Paste a link, or bring your whole library over with a CSV. Nothing changes on Loom.",
		cue: "One link or a whole CSV",
		doodle: <LoomToCapDoodle />,
	},
	{
		path: "record",
		title: "Record a video",
		body: "Capture your screen, camera and mic. Your link is ready the moment you stop.",
		cue: "No download needed",
		doodle: <RecordDoodle />,
	},
	{
		path: "upload",
		title: "Upload a video",
		body: "Turn a recording you already have into a link you can share anywhere.",
		cue: "MP4, MOV or WebM",
		doodle: <UploadDoodle />,
	},
];

export const StartStep = ({
	firstName,
	organizationName,
	continuePath,
	completed,
}: {
	firstName: string;
	organizationName: string | null;
	continuePath: string;
	completed: boolean;
}) => {
	const router = useRouter();
	const { complete } = useGetStarted(completed);
	const [leaving, setLeaving] = useState<User.OnboardingStartPath | null>(null);

	useEffect(() => {
		for (const choice of CHOICES)
			router.prefetch(onboardingStepHref(choice.path));
	}, [router]);

	const choose = (path: Choice["path"]) => {
		trackEvent("onboarding_start_selected", { path });
		setLeaving(path);
		router.push(onboardingStepHref(path));
	};

	const lookAround = async () => {
		trackEvent("onboarding_start_selected", { path: "explore" });
		setLeaving("explore");
		try {
			await complete("explore");
			router.push(continuePath);
			router.refresh();
		} catch {
			setLeaving(null);
			toast.error("Something went wrong. Please try again.");
		}
	};

	return (
		<StepPage className="justify-center">
			<div className="mx-auto flex w-full max-w-[760px] flex-col items-center text-center">
				<StepTitle>
					{organizationName
						? `Welcome to ${organizationName}${firstName ? `, ${firstName}` : ""}`
						: firstName
							? `Hi ${firstName}, let's make your first Cap`
							: "Let's make your first Cap"}
				</StepTitle>
				<StepLede className="mx-auto">
					{organizationName
						? "Pick where you'd like to start. Everything you make lands in your team's library."
						: "Pick where you'd like to start. You can do the others any time from your library."}
				</StepLede>
			</div>

			<ul className="mx-auto mt-10 grid w-full max-w-[1040px] gap-3.5 sm:mt-12 md:grid-cols-3 md:gap-5">
				{CHOICES.map((choice, index) => (
					<li
						key={choice.path}
						className="ob-rise flex"
						style={{ "--d": `${0.12 + index * 0.08}s` } as CSSProperties}
					>
						<button
							type="button"
							onClick={() => choose(choice.path)}
							disabled={leaving !== null}
							aria-busy={leaving === choice.path}
							className="ob-choice w-full flex-row items-center gap-4 p-4 disabled:cursor-wait sm:p-5 md:flex-col md:items-stretch md:gap-0 md:p-6"
						>
							<span className="flex w-[88px] shrink-0 items-center justify-center rounded-2xl bg-[var(--ob-paper-2)] px-2 py-3 sm:w-[104px] md:mb-6 md:w-full md:px-10 md:py-7">
								<span className="block w-full max-w-[150px]">
									{choice.doodle}
								</span>
							</span>
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="text-[17px] font-medium leading-snug tracking-[-0.01em] text-[var(--ob-ink)] md:text-[19px]">
									{choice.title}
								</span>
								<span className="mt-1.5 text-[14px] leading-relaxed text-[var(--ob-ink-soft)] md:text-[14.5px]">
									{choice.body}
								</span>
								<span className="mt-3 hidden items-center justify-between text-[13px] font-medium text-[var(--ob-ink-2)] md:mt-auto md:flex md:pt-6">
									{choice.cue}
									<ArrowRight
										className="ob-choice-arrow size-4 text-[var(--ob-ink-soft)]"
										aria-hidden
									/>
								</span>
							</span>
							<ArrowRight
								className="ob-choice-arrow size-4 shrink-0 text-[var(--ob-ink-soft)] md:hidden"
								aria-hidden
							/>
						</button>
					</li>
				))}
			</ul>

			<div
				className="ob-rise mt-10 flex flex-col items-center gap-2 text-center"
				style={{ "--d": "0.4s" } as CSSProperties}
			>
				<button
					type="button"
					className="ob-link"
					onClick={lookAround}
					disabled={leaving !== null}
				>
					{leaving === "explore" ? "Taking you in…" : "I'll look around first"}
					<ArrowRight className="size-3.5" aria-hidden />
				</button>
			</div>
		</StepPage>
	);
};
