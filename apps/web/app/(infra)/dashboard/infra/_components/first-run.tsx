"use client";

import clsx from "clsx";
import Link from "next/link";
import { useState } from "react";
import { infraAppPath } from "@/lib/infra-routes";
import type { InfraProCredit } from "../infra-data";
import { AgentSetup } from "./agent-setup";
import {
	AppNameForm,
	type CreatedApp,
	type Environment,
	KeysReveal,
	useCreateApp,
} from "./create-app";
import { ProCredit } from "./pro-credit";
import { Brand } from "./shell";
import { Step, StepNote, Steps } from "./steps";
import { Button, ButtonLink, EnvTag, FOCUS } from "./ui";

const QUIET_LINK = clsx(
	"rounded-[6px] px-2.5 py-1.5 text-[13.5px] text-[rgba(232,236,244,0.58)] transition-colors duration-200 hover:text-[#E8ECF4]",
	FOCUS,
);

const LEAD =
	"m-0 max-w-[340px] text-pretty text-[15.5px] leading-[1.6] text-[rgba(232,236,244,0.6)]";

export function FirstRun({
	organizations,
	proCredit,
}: {
	organizations: { id: string; name: string }[];
	proCredit: InfraProCredit;
}) {
	const [created, setCreated] = useState<
		(CreatedApp & { name: string; environment: Environment }) | null
	>(null);
	const create = useCreateApp((app, input) =>
		setCreated({ ...app, ...input, name: input.name.trim() }),
	);

	return (
		<div className="flex min-h-dvh flex-col">
			<header className="mx-auto flex h-14 w-full max-w-[1184px] items-center justify-between px-5 sm:px-8">
				<Brand />
				<nav aria-label="Cap Infra" className="flex items-center">
					<Link href="/docs/api/rest-api" className={QUIET_LINK}>
						Docs
					</Link>
					<Link href="/dashboard/caps" className={QUIET_LINK}>
						Back to Cap
					</Link>
				</nav>
			</header>
			<main className="mx-auto grid w-full max-w-[1184px] flex-1 content-start gap-x-20 gap-y-12 px-5 pb-24 pt-[9vh] sm:px-8 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] lg:pt-[14vh]">
				<div>
					<h1 className="m-0 text-balance text-[clamp(30px,3.4vw,42px)] font-medium leading-[1.06] tracking-[-0.035em] text-[#E8ECF4]">
						Set up Cap Infra.
					</h1>
					<p className={clsx(LEAD, "mt-5")}>
						Name an app and your API keys are ready. Usage is billed from
						prepaid credits, with no plans or seats.
					</p>
					<p className={clsx(LEAD, "mt-4")}>
						Infra is separate from Cap. Your recordings, plan and team stay
						exactly as they are.
						{proCredit.status !== "not_pro" &&
							" Your Cap Pro plan adds $5 of Infra credit every month."}
					</p>
				</div>
				<div className="min-w-0 max-w-[620px]">
					<Steps reached={created ? 3 : 0} total={3}>
						<Step title="Name your app" state={created ? "done" : "current"}>
							{created ? (
								<p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-[rgba(232,236,244,0.72)]">
									{created.name}
									<EnvTag environment={created.environment} />
								</p>
							) : (
								<div className="flex flex-col gap-5">
									{organizations.length > 0 && (
										<div>
											<div className="flex flex-wrap gap-2">
												{organizations.map((organization) => (
													<Button
														key={organization.id}
														variant="ghost"
														disabled={create.isPending}
														onClick={() =>
															create.mutate({
																name: organization.name,
																environment: "development",
															})
														}
														className="max-w-full"
													>
														<span className="truncate">
															Use {organization.name}
														</span>
													</Button>
												))}
											</div>
											<p className="m-0 mt-3 text-[13px] leading-[1.5] text-[rgba(232,236,244,0.46)]">
												Starts an Infra app named after your Cap organization,
												or name a new one below.
											</p>
										</div>
									)}
									<AppNameForm
										submitLabel="Create app"
										pending={create.isPending}
										onSubmit={(input) => create.mutate(input)}
										autoFocus={organizations.length === 0}
									/>
								</div>
							)}
						</Step>
						<Step title="Copy your keys" state={created ? "current" : "next"}>
							{created ? (
								<KeysReveal app={created} />
							) : (
								<StepNote>
									A public key for the browser and a secret key for your server.
								</StepNote>
							)}
						</Step>
						<Step title="Start building" state={created ? "current" : "next"}>
							{created ? (
								<div className="flex flex-col gap-6">
									{proCredit.status === "not_pro" ? (
										<StepNote>
											Uploading needs a balance. Credits start at $5, and Cap
											Pro includes $5 every month.
										</StepNote>
									) : (
										<ProCredit
											appId={created.appId}
											credit={proCredit}
											refresh={false}
										/>
									)}
									<AgentSetup compact />
									<div className="flex flex-wrap gap-2.5">
										<ButtonLink href={infraAppPath(created.appId)}>
											Open dashboard
										</ButtonLink>
										{proCredit.status === "not_pro" && (
											<ButtonLink
												variant="ghost"
												href={infraAppPath(created.appId, "billing")}
											>
												Add credits
											</ButtonLink>
										)}
									</div>
								</div>
							) : (
								<StepNote>
									Hand one prompt to your agent, or drop your first video into
									the dashboard.
								</StepNote>
							)}
						</Step>
					</Steps>
				</div>
			</main>
		</div>
	);
}
