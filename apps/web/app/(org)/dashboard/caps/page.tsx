import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { capKindHref } from "@/lib/cap-kind";
import { parsePageParam } from "@/lib/page-param";
import { CapsPageView } from "./caps-page-data";

export const metadata: Metadata = {
	title: "My Caps — Cap",
};

export default async function CapsPage(props: PageProps<"/dashboard/caps">) {
	const searchParams = await props.searchParams;
	if (searchParams.page !== undefined)
		redirect(
			`${capKindHref("videos")}?page=${parsePageParam(searchParams.page)}`,
		);
	return CapsPageView({ searchParams, view: "library" });
}
