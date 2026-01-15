import { AuthContextProvider } from "@/app/Layout/AuthContext";
import { resolveCurrentUser } from "@/app/Layout/current-user";
import { runPromise } from "@/lib/server";
import { UploadingProvider } from "../dashboard/caps/UploadingContext";

export const dynamic = "force-dynamic";

export default async function RecordLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<AuthContextProvider user={runPromise(resolveCurrentUser)}>
			<UploadingProvider>{children}</UploadingProvider>
		</AuthContextProvider>
	);
}
