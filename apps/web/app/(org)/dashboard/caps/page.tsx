import type { Metadata } from "next";
import { CapsPageView } from "./caps-page-data";

export const metadata: Metadata = {
	title: "My Caps — Cap",
};

export default async function CapsPage(props: PageProps<"/dashboard/caps">) {
	return CapsPageView({
		searchParams: await props.searchParams,
		view: "library",
	});
}
