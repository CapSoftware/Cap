import type { Metadata } from "next";
import { RecordVideoPage } from "./RecordVideoPage";

export const metadata: Metadata = {
	title: "Record Video",
};

export default function RecordVideoRoute() {
	return <RecordVideoPage />;
}
