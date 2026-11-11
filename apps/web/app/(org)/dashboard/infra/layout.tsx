import type { Metadata } from "next";
import { InfraThemeForcer } from "./_components/infra-theme-forcer";

export const metadata: Metadata = {
	title: "Cap Infra",
};

export default function InfraLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return <InfraThemeForcer>{children}</InfraThemeForcer>;
}
