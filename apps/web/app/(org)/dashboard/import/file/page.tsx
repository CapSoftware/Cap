import type { Metadata } from "next";
import { ImportFilePage } from "./ImportFilePage";

export const metadata: Metadata = {
	title: "上传文件 — Cap",
};

export default function Page() {
	return <ImportFilePage />;
}
