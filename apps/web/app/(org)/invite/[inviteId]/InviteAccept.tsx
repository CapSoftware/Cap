"use client";

import { ArrowRight, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { type CSSProperties, useState } from "react";
import { toast } from "sonner";
import { resetUser, trackEvent } from "@/app/utils/analytics";
import { CapWordmark, Explainer } from "../../onboarding/components/paper";
import {
	StepLede,
	StepPage,
	StepTitle,
} from "../../onboarding/components/StepChrome";
import { JoinScene } from "../../onboarding/components/scenes";
import { clearOnboardingNextPath } from "../../onboarding-next";

type InviteAcceptProps = {
	inviteId: string;
	organizationName: string;
	inviterName: string;
	maskedEmail: string;
	invitedInitial: string;
	signedInEmail: string | null;
	emailMatches: boolean;
	needsOnboarding: boolean;
};

export function InviteAccept({
	inviteId,
	organizationName,
	inviterName,
	maskedEmail,
	invitedInitial,
	signedInEmail,
	emailMatches,
	needsOnboarding,
}: InviteAcceptProps) {
	const router = useRouter();
	const [pending, setPending] = useState<
		"accept" | "decline" | "switch" | null
	>(null);
	const invitePath = `/invite/${inviteId}`;
	const signedIn = signedInEmail !== null;
	const inviterFirstName = inviterName.trim().split(/\s+/)[0] ?? inviterName;

	const respond = async (action: "accept" | "decline") => {
		setPending(action);
		try {
			const response = await fetch(`/api/invite/${action}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ inviteId }),
			});

			if (!response.ok) {
				const message =
					response.status === 403
						? "This invite was sent to a different email address."
						: response.status === 404
							? "This invite is no longer available. Ask your teammate to send a new one."
							: "Something went wrong. Please try again.";
				toast.error(message);
				setPending(null);
				return;
			}

			clearOnboardingNextPath();
			if (action === "accept") {
				trackEvent("invite_accepted");
				router.push(needsOnboarding ? "/onboarding" : "/dashboard/caps");
			} else {
				trackEvent("invite_declined");
				router.push("/dashboard");
			}
			router.refresh();
		} catch {
			toast.error("Something went wrong. Please try again.");
			setPending(null);
		}
	};

	const switchAccount = () => {
		setPending("switch");
		resetUser();
		signOut({ callbackUrl: `/login?next=${encodeURIComponent(invitePath)}` });
	};

	return (
		<>
			<header className="mx-auto flex w-full max-w-[1180px] items-center justify-between gap-3 px-5 pt-5 sm:px-8 sm:pt-7">
				<CapWordmark className="h-[26px] w-auto text-[var(--ob-ink)] sm:h-7" />
				{signedIn && (
					<span className="min-w-0 truncate text-[13px] text-[var(--ob-ink-soft)]">
						{signedInEmail}
					</span>
				)}
			</header>
			<main className="flex flex-1 flex-col">
				<StepPage>
					<div className="grid flex-1 items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-14">
						<div className="flex min-w-0 flex-col">
							<div className="ob-rise mb-5 flex items-center gap-3">
								<span className="flex size-12 items-center justify-center rounded-full bg-[var(--ob-accent)] text-[18px] font-medium text-white">
									{inviterFirstName.charAt(0).toUpperCase()}
								</span>
								<p className="text-[15px] leading-snug text-[var(--ob-ink-soft)]">
									<span className="font-medium text-[var(--ob-ink)]">
										{inviterName}
									</span>{" "}
									invited you
								</p>
							</div>
							<StepTitle>
								Join <span className="break-words">{organizationName}</span> on
								Cap
							</StepTitle>
							<StepLede>
								Watch your team's videos, record your own and share them in one
								place. It only takes a minute to get set up.
							</StepLede>

							<div
								className="ob-rise mt-8 flex flex-col gap-3"
								style={{ "--d": "0.12s" } as CSSProperties}
							>
								{!signedIn ? (
									<>
										<Link
											href={`/signup?next=${encodeURIComponent(invitePath)}`}
											className="ob-cta w-full sm:w-fit"
											onClick={() => trackEvent("invite_join_clicked")}
										>
											Join {organizationName}
											<ArrowRight className="ob-cta-arrow size-4" aria-hidden />
										</Link>
										<p className="text-[14px] text-[var(--ob-ink-soft)]">
											Use {maskedEmail}, the address this invite was sent to.
											Already on Cap?{" "}
											<Link
												href={`/login?next=${encodeURIComponent(invitePath)}`}
												className="ob-link !inline !text-[14px]"
											>
												Log in
											</Link>
										</p>
									</>
								) : emailMatches ? (
									<>
										<div className="flex flex-col gap-3 sm:flex-row sm:items-center">
											<button
												type="button"
												className="ob-cta w-full sm:w-fit"
												disabled={pending !== null}
												onClick={() => respond("accept")}
											>
												{pending === "accept" ? (
													<>
														<LoaderCircle
															className="size-4 animate-spin"
															aria-hidden
														/>
														Joining…
													</>
												) : (
													<>
														Join {organizationName}
														<ArrowRight
															className="ob-cta-arrow size-4"
															aria-hidden
														/>
													</>
												)}
											</button>
											<button
												type="button"
												className="ob-link self-center sm:self-auto"
												disabled={pending !== null}
												onClick={() => respond("decline")}
											>
												{pending === "decline" ? "Declining…" : "Not now"}
											</button>
										</div>
										<p className="text-[14px] text-[var(--ob-ink-soft)]">
											You're signed in as {signedInEmail}.
										</p>
									</>
								) : (
									<>
										<div className="rounded-2xl border-[1.5px] border-dashed border-[var(--ob-track-strong)] bg-white/60 px-4 py-3.5 text-[14.5px] leading-relaxed text-[var(--ob-ink-2)]">
											This invite was sent to{" "}
											<span className="font-medium text-[var(--ob-ink)]">
												{maskedEmail}
											</span>
											, but you're signed in as{" "}
											<span className="font-medium text-[var(--ob-ink)] break-all">
												{signedInEmail}
											</span>
											. Switch to that account to join.
										</div>
										<div className="flex flex-col gap-3 sm:flex-row sm:items-center">
											<button
												type="button"
												className="ob-cta w-full sm:w-fit"
												disabled={pending !== null}
												onClick={switchAccount}
											>
												{pending === "switch" ? "Switching…" : "Switch account"}
											</button>
											<Link
												href="/dashboard"
												className="ob-link self-center sm:self-auto"
											>
												Go to my library
											</Link>
										</div>
									</>
								)}
							</div>
						</div>

						<Explainer
							className="ob-rise"
							label={`How joining ${organizationName} works`}
							loopSeconds={8}
							scene={
								<JoinScene
									organizationName={organizationName}
									initial={invitedInitial}
								/>
							}
							steps={[
								{
									title: "Press Join",
									body: `Use ${maskedEmail}, the address this invite was sent to.`,
								},
								{
									title: "Say hello",
									body: "Add your name so your teammates know it's you.",
								},
								{
									title: "Watch, record and share together",
									body: `Everything ${organizationName} records lands in one shared library.`,
								},
							]}
						/>
					</div>
				</StepPage>
			</main>
		</>
	);
}
