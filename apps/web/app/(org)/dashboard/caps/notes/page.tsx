import type { Metadata } from "next";
import { CapsPageView } from "../caps-page-data";

export const metadata: Metadata = {
	title: "Notes — Cap",
};

export default async function NotesCapsPage(
	props: PageProps<"/dashboard/caps/notes">,
) {
	return CapsPageView({
		searchParams: await props.searchParams,
		view: "library",
		kind: "notes",
	});
}
