import { Button } from "@cap/ui";
import { Suspense } from "react";
import { LoginForm } from "./form";
import { getCurrentUser } from "@cap/database/auth/session";
import { redirect } from "next/navigation";
import Image from "next/image";

export default async function LoginPage() {
  const session = await getCurrentUser();

  if (session) {
    redirect("/dashboard");
  }

  return (
    <div className="relative w-full min-h-screen flex items-center justify-center bg-[#0A0F1C]">
      {/* Background Gradients */}
      <div className="absolute inset-0">
        <div className="absolute top-10 -left-24 z-0 w-[1276px] h-[690px] opacity-20 pointer-events-none md:opacity-100">
          <div className="w-full h-full rounded-full bg-gradient-to-r from-[#75A3FE] to-transparent blur-[50px]" />
        </div>
      </div>
      
      {/* Main Content */}
      <div className="w-full max-w-lg relative z-10 overflow-hidden rounded-2xl p-8 space-y-6 bg-white/5 backdrop-blur-xl border border-white/10">
        <a href="/" className="block">
          <div className="flex items-center justify-center">
            <Image
              src="/design/OPAVC Logo.svg"
              alt="OPAVC Logo"
              width={200}
              height={60}
              priority
              className="h-12 w-auto brightness-200"
            />
          </div>
        </a>
        <div className="text-center flex flex-col items-center justify-center space-y-3">
          <h1 className="text-3xl font-semibold text-white">
            Sign in to OPAVC
          </h1>
          <p className="text-xl text-gray-400 max-w-sm">
            Access your organization's resources
          </p>
        </div>
        <div className="flex flex-col space-y-3">
          <Suspense
            fallback={
              <>
                <Button disabled={true} variant="primary" />
                <Button disabled={true} variant="secondary" />
                <Button disabled={true} variant="destructive" />
                <div className="mx-auto h-5 w-3/4 rounded-lg bg-gray-800" />
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
