import "../(site)/tailwind-base.css";
import type { PropsWithChildren } from "react";
import { InfraShell } from "@/components/pages/infra/Shell";

/** Cap Infra posts sit on the /infra page's own night shell. */
export default function InfraPostLayout(props: PropsWithChildren) {
	return <InfraShell anchorBase="/infra">{props.children}</InfraShell>;
}
