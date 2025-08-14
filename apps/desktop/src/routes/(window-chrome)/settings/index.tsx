import { Navigate, useSearchParams } from "@solidjs/router";

export default function Settings() {
	const [searchParams] = useSearchParams();
	const page = (searchParams.page as string) || "general";

	return <Navigate href={page} />;
}
