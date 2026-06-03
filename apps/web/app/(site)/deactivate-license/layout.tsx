import type { PropsWithChildren } from "react";
import { PublicPageProviders } from "@/app/Layout/PublicPageProviders";

export default function DeactivateLicenseLayout({
	children,
}: PropsWithChildren) {
	return <PublicPageProviders>{children}</PublicPageProviders>;
}
