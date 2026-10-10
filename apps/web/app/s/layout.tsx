import type { PropsWithChildren } from "react";
import { AppProviders } from "../Layout/AppProviders";
import { ShareTheme } from "./ShareTheme";

export const dynamic = "force-dynamic";

export default function ShareLayout({ children }: PropsWithChildren) {
	return (
		<AppProviders>
			<ShareTheme />
			<div className="min-h-screen bg-gray-2 text-gray-12">{children}</div>
		</AppProviders>
	);
}
