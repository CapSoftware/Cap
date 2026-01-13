import type { PropsWithChildren } from "react";
import { formatStarCount, getGitHubStars } from "@/utils/github";
import { Intercom } from "../Layout/Intercom";
import { Footer } from "./Footer";
import { Navbar } from "./Navbar";

export default async function Layout(props: PropsWithChildren) {
	const starCount = await getGitHubStars();
	const stars = formatStarCount(starCount);

	return (
		<>
			<Navbar stars={stars} />
			{props.children}
			<Footer />
			<Intercom />
		</>
	);
}
