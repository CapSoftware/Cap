"use client";

import clsx from "clsx";
import Link from "next/link";
import { useState } from "react";
import { infraAppPath } from "@/lib/infra-routes";
import {
	AppNameForm,
	type CreatedApp,
	type Environment,
	KeysReveal,
	useCreateApp,
} from "./create-app";
import { Brand } from "./shell";
import { Step, StepNote, Steps } from "./steps";
import { ButtonLink, EnvTag, FOCUS } from "./ui";

const QUIET_LINK = clsx(
	"rounded-[6px] px-2.5 py-1.5 text-[13.5px] text-[rgba(232,236,244,0.58)] transition-colors duration-200 hover:text-[#E8ECF4]",
	FOCUS,
);

export function FirstRun() {
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
					<p className="m-0 mt-5 max-w-[340px] text-pretty text-[15.5px] leading-[1.6] text-[rgba(232,236,244,0.6)]">
						Name an app and your API keys are ready. Uploads, storage and
						delivery are billed from prepaid credits, with no plans or seats.
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
								<AppNameForm
									submitLabel="Create app"
									pending={create.isPending}
									onSubmit={(input) => create.mutate(input)}
									autoFocus
								/>
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
						<Step
							title="Add credits and upload"
							state={created ? "current" : "next"}
						>
							{created ? (
								<div className="flex flex-col gap-4">
									<StepNote>
										Creating a video needs a balance. Credits start at $5 and
										your dashboard has the first request ready to copy.
									</StepNote>
									<div className="flex flex-wrap gap-2.5">
										<ButtonLink href={infraAppPath(created.appId, "billing")}>
											Add credits
										</ButtonLink>
										<ButtonLink
											variant="ghost"
											href={infraAppPath(created.appId)}
										>
											Open dashboard
										</ButtonLink>
									</div>
								</div>
							) : (
								<StepNote>
									Top up from $5, then create your first video with one request.
								</StepNote>
							)}
						</Step>
					</Steps>
				</div>
			</main>
		</div>
	);
}
