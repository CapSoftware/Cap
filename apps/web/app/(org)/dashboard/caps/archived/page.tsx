import type { Metadata } from "next";
import { CapsPageView } from "../caps-page-data";

export const metadata: Metadata = {
	title: "Archived — Cap",
};

export default async function ArchivedCapsPage(
	props: PageProps<"/dashboard/caps/archived">,
) {
	return CapsPageView({
		searchParams: await props.searchParams,
		view: "archived",
	});
}
