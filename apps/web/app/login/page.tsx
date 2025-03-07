import { Button, LogoBadge } from "@cap/ui";
import { Suspense } from "react";
import { LoginForm } from "./form";
import { getCurrentUser } from "@cap/database/auth/session";
import { redirect } from "next/navigation";
import Loading from "../dashboard/loading";
import { getServerConfigAction } from "../actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const session = await getCurrentUser();
  const serverConfig = await getServerConfigAction();

  if (session) {
    redirect("/dashboard");
  }

  const showSignupDisabledError = searchParams.error === "signupDisabled";

  return (
    <div className="muted-custom-bg w-full h-screen flex items-center justify-center">
      <div className="w-full max-w-lg relative overflow-hidden sm:rounded-2xl p-4 space-y-4">
        <a href="/">
          <LogoBadge className="h-12 w-auto fade-in-down" />
        </a>
        <div className="text-left flex flex-col items-start justify-center space-y-3">
          <h1 className="text-3xl font-semibold fade-in-down animate-delay-1">
            Sign in to Cap.
          </h1>
          <p className="text-2xl text-gray-500 fade-in-down animate-delay-1">
            Beautiful screen recordings, owned by you.
          </p>
        </div>
        {showSignupDisabledError && (
          <div className="mb-4 px-6 py-4 bg-red-600 rounded-lg flex flex-col gap-2">
            <p className="font-bold text-gray-50">Sign-ups are disabled</p>
            <p className=" text-gray-50">
              Only existing users can sign in at this time.
            </p>
          </div>
        )}
        <div className="flex flex-col space-y-3">
          <Suspense
            fallback={
              <>
                <Loading />
              </>
            }
          >
            <LoginForm serverConfig={serverConfig} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
