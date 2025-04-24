import { getCurrentUser } from "@cap/database/auth/session";
import { redirect } from "next/navigation";
import { LoginForm } from "./form";

export default async function LoginPage() {
  const session = await getCurrentUser();
  if (session) {
    redirect("/dashboard");
  }
  return <LoginForm />;
}
