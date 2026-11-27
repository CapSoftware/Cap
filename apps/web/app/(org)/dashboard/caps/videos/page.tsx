import type { Metadata } from "next";
import { CapsPageView } from "../caps-page-data";

export const metadata: Metadata = {
	title: "Videos — Cap",
};

export default async function VideosCapsPage(
	props: PageProps<"/dashboard/caps/videos">,
) {
	return CapsPageView({
		searchParams: await props.searchParams,
		view: "library",
		kind: "videos",
	});
}
