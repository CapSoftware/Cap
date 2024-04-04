import { Button, LogoBadge } from "@cap/ui";
import { Suspense } from "react";
import { LoginForm } from "./form";
import { getCurrentUser } from "@cap/database/auth/session";
import { redirect } from "next/navigation";

export default async function LoginPage() {
  const session = await getCurrentUser();

  if (session) {
    redirect("/dashboard");
  }

  return (
    <div className="muted-custom-bg wrapper w-full h-screen flex items-center justify-center">
      <div className="w-full max-w-lg relative overflow-hidden sm:rounded-2xl p-4 space-y-4">
        <a href="/">
          <LogoBadge className="h-12 w-auto" />
        </a>
        <div className="text-left flex flex-col items-start justify-center space-y-3">
          <h1 className="text-3xl font-semibold">Sign in to Cap.</h1>
          <p className="text-2xl text-gray-500">
            Effortless, instant screen sharing. Open source and cross-platform.
          </p>
        </div>
        <div className="flex flex-col space-y-3">
          <Suspense
            fallback={
              <>
                <Button disabled={true} variant="default" />
                <Button disabled={true} variant="default" />
                <Button disabled={true} variant="default" />
                <div className="mx-auto h-5 w-3/4 rounded-lg bg-gray-100" />
              </>
            }
          >
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
