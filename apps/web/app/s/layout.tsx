import type { PropsWithChildren } from "react";
import { AppProviders } from "../Layout/AppProviders";

export default function ShareLayout({ children }: PropsWithChildren) {
	return <AppProviders>{children}</AppProviders>;
}
