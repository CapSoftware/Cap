import type { PropsWithChildren } from "react";
import { PublicPageProviders } from "../Layout/PublicPageProviders";

export default function EmbedLayout({ children }: PropsWithChildren) {
	return <PublicPageProviders>{children}</PublicPageProviders>;
}
