import type { PropsWithChildren } from "react";
import { PublicPageProviders } from "@/app/Layout/PublicPageProviders";

export default function StudentDiscountLayout({ children }: PropsWithChildren) {
	return <PublicPageProviders>{children}</PublicPageProviders>;
}
