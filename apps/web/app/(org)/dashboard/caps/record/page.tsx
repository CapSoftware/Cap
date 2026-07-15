import type { Metadata } from "next";
import { RecordVideoPage } from "./RecordVideoPage";

export const metadata: Metadata = {
	title: "录制 Cap",
};

export default function RecordVideoRoute() {
	return <RecordVideoPage />;
}
