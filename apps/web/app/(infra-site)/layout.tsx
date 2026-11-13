import "../(site)/tailwind-base.css";
import type { PropsWithChildren } from "react";
import { InfraShell } from "@/components/pages/infra/Shell";

export default function InfraLayout(props: PropsWithChildren) {
	return <InfraShell>{props.children}</InfraShell>;
}
