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
            Beautiful, shareable screen recordings.
          </p>
        </div>
        <div className="flex flex-col space-y-3">
          <Suspense
            fallback={
              <>
                <Button disabled={true} variant="primary" />
                <Button disabled={true} variant="secondary" />
                <Button disabled={true} variant="destructive" />
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
