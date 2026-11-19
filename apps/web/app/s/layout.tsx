import type { PropsWithChildren } from "react";
import { AppProviders } from "../Layout/AppProviders";
import { ShareNowProvider } from "./[videoId]/_components/RelativeTime";

export const dynamic = "force-dynamic";

export default function ShareLayout({ children }: PropsWithChildren) {
	return (
		<AppProviders>
			<ShareNowProvider now={Date.now()}>{children}</ShareNowProvider>
		</AppProviders>
	);
}
