import type { Metadata } from "next";
import { ImportFilePage } from "./ImportFilePage";

export const metadata: Metadata = {
	title: "Upload File — Cap",
};

export default function Page() {
	return <ImportFilePage />;
}
