import clsx from "clsx";
import Link from "next/link";
import { infraAppPath } from "@/lib/infra-routes";
import type { InfraProCredit } from "../infra-data";
import { CodeBlock } from "./copy";
import { createUploadCurl } from "./infra-examples";
import { ProCredit } from "./pro-credit";
import { Step, StepNote, Steps } from "./steps";
import { ButtonLink, Disclosure, MONO, TEXT_LINK } from "./ui";

const Endpoint = ({ children }: { children: string }) => (
	<code className={clsx(MONO, "text-[12.5px] text-[rgba(232,236,244,0.86)]")}>
		{children}
	</code>
);

export function FirstCredit({
	appId,
	balanceMicroCredits,
	proCredit,
	refresh = true,
}: {
	appId: string;
	balanceMicroCredits: number;
	proCredit: InfraProCredit;
	refresh?: boolean;
}) {
	if (balanceMicroCredits > 0) return null;
	if (proCredit.status === "available") {
		return <ProCredit appId={appId} credit={proCredit} refresh={refresh} />;
	}
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-3">
			<ButtonLink href={infraAppPath(appId, "billing")}>Add credits</ButtonLink>
			<StepNote>
				{proCredit.status === "claimed"
					? "Uploading needs a balance. This month's Cap Pro credit is already claimed, and it is one per account, not one per app."
					: "Uploading needs a balance. Credits start at $5, and Cap Pro includes $5 every month."}
			</StepNote>
		</div>
	);
}

export function ApiGuide() {
	return (
		<Disclosure
			summary="Using the API"
			note="Create and read videos from your own code."
		>
			<div className="max-w-[640px]">
				<Steps reached={0} total={3}>
					<Step title="Create an upload on your server" state="current">
						<div className="flex flex-col gap-3">
							<CodeBlock code={createUploadCurl()} label="create request" />
							<StepNote>
								Send this with your secret key. It creates the video and returns
								a <Endpoint>token</Endpoint> that uploads that one video and
								expires after an hour.
							</StepNote>
						</div>
					</Step>
					<Step title="Send the file from the browser" state="current">
						<StepNote>
							Give the browser the token, never a key. With it as the Bearer
							credential, call <Endpoint>upload/multipart/initiate</Endpoint>,{" "}
							<Endpoint>presign-part</Endpoint> and{" "}
							<Endpoint>complete</Endpoint>, passing the duration, width and
							height to <Endpoint>complete</Endpoint>.
						</StepNote>
					</Step>
					<Step title="Read it from your server" state="current">
						<StepNote>
							<Endpoint>GET /api/developer/v1/videos/:id/status</Endpoint> with
							your secret key returns <Endpoint>ready: true</Endpoint> and the
							playback links once the video has processed. The full reference is
							in the{" "}
							<Link href="/docs/api/rest-api" className={TEXT_LINK}>
								API docs
							</Link>
							.
						</StepNote>
					</Step>
				</Steps>
			</div>
		</Disclosure>
	);
}
