import { Navigate } from "@solidjs/router";
import { useSearchParams } from "@solidjs/router";

export default function Settings() {
  const [searchParams] = useSearchParams();
  const page = searchParams.page || "general";

  return <Navigate href={page} />;
}
