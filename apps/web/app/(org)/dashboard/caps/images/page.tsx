import type { Metadata } from "next";
import { CapsPageView } from "../caps-page-data";

export const metadata: Metadata = {
	title: "Images — Cap",
};

export default async function ImagesCapsPage(
	props: PageProps<"/dashboard/caps/images">,
) {
	return CapsPageView({
		searchParams: await props.searchParams,
		view: "library",
		kind: "images",
	});
}
