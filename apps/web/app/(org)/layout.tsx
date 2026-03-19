import { buildEnv } from "@cap/env";
import type { PropsWithChildren } from "react";
import { MessengerWidget } from "../Layout/MessengerWidget";

export default function Layout(props: PropsWithChildren) {
	return (
		<>
			{props.children}
			{buildEnv.NEXT_PUBLIC_IS_CAP === "true" && <MessengerWidget />}
		</>
	);
}
