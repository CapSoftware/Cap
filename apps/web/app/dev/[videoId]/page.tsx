import { redirect } from "next/navigation";

export default async function DevVideoPage({
	params,
}: {
	params: Promise<{ videoId: string }>;
}) {
	const { videoId } = await params;
	redirect(`/embed/${videoId}?sdk=1`);
}
