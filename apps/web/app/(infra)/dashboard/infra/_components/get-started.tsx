import clsx from "clsx";
import Link from "next/link";
import { infraAppPath } from "@/lib/infra-routes";
import { formatCredits } from "@/lib/infra-usage";
import type { InfraProCredit } from "../infra-data";
import { CodeBlock } from "./copy";
import { createVideoCurl } from "./infra-examples";
import { ProCredit } from "./pro-credit";
import { Step, StepNote, Steps } from "./steps";
import { ButtonLink, MONO, TEXT_LINK } from "./ui";

const Endpoint = ({ children }: { children: string }) => (
	<code className={clsx(MONO, "text-[12.5px] text-[rgba(232,236,244,0.86)]")}>
		{children}
	</code>
);

export function GetStarted({
	appId,
	publicKey,
	isProduction,
	balanceMicroCredits,
	proCredit,
	uploadHere = false,
}: {
	appId: string;
	publicKey: string;
	isProduction: boolean;
	balanceMicroCredits: number;
	proCredit: InfraProCredit;
	uploadHere?: boolean;
}) {
	const funded = balanceMicroCredits > 0;

	return (
		<Steps reached={funded ? 1 : 0} total={3}>
			<Step title="Add credits" state={funded ? "done" : "current"}>
				{funded ? (
					<StepNote>
						{formatCredits(balanceMicroCredits)} available for this app.
					</StepNote>
				) : proCredit.status === "available" ? (
					<ProCredit appId={appId} credit={proCredit} />
				) : (
					<div className="flex flex-col items-start gap-4">
						<StepNote>
							Uploading a video needs a balance. Credits start at $5.
						</StepNote>
						<ButtonLink size="sm" href={infraAppPath(appId, "billing")}>
							Add credits
						</ButtonLink>
					</div>
				)}
			</Step>
			<Step title="Upload a video" state={funded ? "current" : "next"}>
				<div className="flex flex-col gap-3">
					<StepNote>
						{uploadHere ? (
							"Drop a file into the box above, or create one through the API:"
						) : (
							<>
								Drop a file into{" "}
								<Link
									href={infraAppPath(appId, "videos")}
									className={TEXT_LINK}
								>
									Videos
								</Link>
								, or create one through the API:
							</>
						)}
					</StepNote>
					<CodeBlock
						code={createVideoCurl(publicKey, isProduction)}
						label="create request"
					/>
					<StepNote>
						{isProduction
							? "Production apps check the Origin header, so replace it with one of this app's allowed domains."
							: "Development apps accept this from anywhere, including your terminal."}{" "}
						Then send the file with{" "}
						<Endpoint>upload/multipart/initiate</Endpoint>,{" "}
						<Endpoint>presign-part</Endpoint> and <Endpoint>complete</Endpoint>,
						passing the duration, width and height to{" "}
						<Endpoint>complete</Endpoint>.
					</StepNote>
				</div>
			</Step>
			<Step title="Read it from your server" state="next">
				<StepNote>
					<Endpoint>GET /api/developer/v1/videos/:id/status</Endpoint> with your
					secret key returns <Endpoint>ready: true</Endpoint> once the upload is
					complete. The full reference is in the{" "}
					<Link href="/docs/api/rest-api" className={TEXT_LINK}>
						API docs
					</Link>
					.
				</StepNote>
			</Step>
		</Steps>
	);
}
