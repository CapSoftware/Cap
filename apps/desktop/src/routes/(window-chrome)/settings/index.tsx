import { Navigate } from "@solidjs/router";
import { useSearchParams } from "@solidjs/router";

export default function Settings() {
  const [searchParams] = useSearchParams();
  const page = searchParams.page || "hotkeys";

  return <Navigate href={page} />;
}
