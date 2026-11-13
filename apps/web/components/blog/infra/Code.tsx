import {
	CREATE_UPLOAD,
	GET_VIDEO_STATUS,
	VIDEO_STATUS_RESPONSE,
} from "@/components/pages/infra/content";
import { highlight } from "@/components/pages/infra/highlight";
import { MONO } from "@/components/pages/infra/theme";
import { HAIRLINE, InfraStage, MUTED } from "./Stage";

const Block = ({ label, code }: { label: string; code: string }) => (
	<div className="min-w-0">
		<div className={`px-5 pt-5 text-[13px] leading-none sm:px-7 ${MUTED}`}>
			{label}
		</div>
		<pre
			className={`${MONO} m-0 overflow-x-auto bg-transparent px-5 pb-6 pt-4 text-[12.5px] leading-[1.7] sm:px-7`}
		>
			<code>{highlight(code)}</code>
		</pre>
	</div>
);

/** The whole video API in two requests, with the answer you get back. */
export function InfraCode() {
	return (
		<InfraStage caption="Create an upload, send the file in parts with the upload token, then check the status until it's ready.">
			<Block
				label="Create an upload and check its status"
				code={`${CREATE_UPLOAD}\n\n${GET_VIDEO_STATUS}`}
			/>
			<div className={`border-t ${HAIRLINE}`}>
				<Block label="When it's ready" code={VIDEO_STATUS_RESPONSE} />
			</div>
		</InfraStage>
	);
}
