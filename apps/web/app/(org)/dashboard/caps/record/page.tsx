import type { Metadata } from "next";
import { RecordVideoPage } from "./RecordVideoPage";

export const metadata: Metadata = {
	title: "Record a Cap",
};

export default async function RecordVideoRoute({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { recorder } = await searchParams;
	return <RecordVideoPage openBrowserRecorder={recorder === "browser"} />;
}
