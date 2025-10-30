import type { PropsWithChildren } from "react";
import { Intercom } from "../Layout/Intercom";
import { Footer } from "./Footer";
import { Navbar } from "./Navbar";

export default function Layout(props: PropsWithChildren) {
	return (
		<>
			<Navbar />
			{props.children}
			<Footer />
			<Intercom />
		</>
	);
}
