import { getCurrentUser } from "@cap/database/auth/session";
import { faArrowLeft } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import Link from "next/link";
import { redirect } from "next/navigation";
import { LoginForm } from "./form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {

  const session = await getCurrentUser();
  if (session) {
    redirect("/dashboard");
  }
  return (
    <div className="flex relative justify-center items-center w-full h-screen bg-gray-2">
      <div className="flex absolute top-10 left-10 gap-2 justify-center items-center transition-opacity hover:opacity-75">
        <FontAwesomeIcon className="opacity-75 size-3 text-gray-12" icon={faArrowLeft} />
        <Link
         className="text-gray-12" href="/">Home</Link>
      </div>
      <LoginForm />
    </div>
  )
}
