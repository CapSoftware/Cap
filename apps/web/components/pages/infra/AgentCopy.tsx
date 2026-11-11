"use client";

import { trackEvent } from "@/app/utils/analytics";
import {
	CopyIconButton,
	CopyLabelButton,
} from "@/components/pages/agents/copy";
import {
	CAP_INFRA_AGENT_PROMPT,
	CAP_INFRA_POINTER_PROMPT,
} from "@/data/infra-agent-prompt";
import { BTN_PRIMARY } from "./theme";

const track = (variant: "full" | "pointer") =>
	trackEvent("infra_prompt_copied", {
		source_page: "infra",
		cta_location: "agent_section",
		variant,
	});

export const CopyPromptButton = ({ className }: { className?: string }) => (
	<CopyLabelButton
		text={CAP_INFRA_AGENT_PROMPT}
		onCopy={() => track("full")}
		className={`${BTN_PRIMARY} !h-11 !rounded-[9px] !px-5 !text-[15px] ${className ?? ""}`}
	>
		Copy prompt
	</CopyLabelButton>
);

export const CopyPointerButton = ({ className }: { className?: string }) => (
	<CopyIconButton
		text={CAP_INFRA_POINTER_PROMPT}
		label="one-line prompt"
		dark
		onCopy={() => track("pointer")}
		className={className}
	/>
);
