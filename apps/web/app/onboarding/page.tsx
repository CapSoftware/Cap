import { Button, LogoBadge } from "@cap/ui";
import { Suspense } from "react";
import { getCurrentUser } from "@cap/database/auth/session";
import { redirect } from "next/navigation";
import { Onboarding } from "./Onboarding";

export default async function OnboardingPage() {
  const user = await getCurrentUser();

  if (
    user &&
    user.name &&
    user.name.length > 1 &&
    user.activeSpaceId &&
    user.activeSpaceId.length > 1
  ) {
    redirect("/dashboard");
  }

  return (
    <div className="muted-custom-bg-2 w-full h-screen flex items-center justify-center">
      <div className="w-full max-w-lg relative overflow-hidden sm:rounded-2xl p-4 space-y-4">
        <a href="/">
          <LogoBadge className="h-14 mx-auto w-auto fade-in-down" />
        </a>
        <div className="text-center flex flex-col items-center justify-center space-y-3">
          <h1 className="text-3xl font-semibold fade-in-down animate-delay-1">
            Welcome to OPAVC
          </h1>
          <p className="text-2xl text-gray-500 fade-in-down animate-delay-1">
            Let's get you started with your organization's account.
          </p>
        </div>
        <div className="fade-in-down animate-delay-2 flex flex-col space-y-3">
          <Onboarding user={user ?? null} />
        </div>
      </div>
    </div>
  );
}
