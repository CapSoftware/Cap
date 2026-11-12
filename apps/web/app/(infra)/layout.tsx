import type { PropsWithChildren } from "react";
import { AppProviders } from "../Layout/AppProviders";

export const dynamic = "force-dynamic";

export default function InfraGroupLayout({ children }: PropsWithChildren) {
	return <AppProviders>{children}</AppProviders>;
}
