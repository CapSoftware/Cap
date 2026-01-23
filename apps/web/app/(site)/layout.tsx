import { buildEnv } from "@inflight/env";
import type { PropsWithChildren } from "react";
import { Intercom } from "../Layout/Intercom";
import { BlackFridayBanner } from "./BlackFridayBanner";
import { Footer } from "./Footer";
import { Navbar } from "./Navbar";

export default function Layout(props: PropsWithChildren) {
	const showBanner = buildEnv.NEXT_PUBLIC_IS_CAP === "true";

	return (
		<>
			<BlackFridayBanner />
			<Navbar />
			{showBanner && <div className="h-[36px]" />}
			{props.children}
			<Footer />
			<Intercom />
		</>
	);
}
