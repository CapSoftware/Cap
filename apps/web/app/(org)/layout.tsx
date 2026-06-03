import { buildEnv } from "@cap/env";
import type { PropsWithChildren } from "react";
import { AppProviders } from "../Layout/AppProviders";
import { DeferredMessengerWidget } from "../Layout/DeferredMessengerWidget";

export default function Layout(props: PropsWithChildren) {
	return (
		<AppProviders>
			{props.children}
			{buildEnv.NEXT_PUBLIC_IS_CAP === "true" && <DeferredMessengerWidget />}
		</AppProviders>
	);
}
