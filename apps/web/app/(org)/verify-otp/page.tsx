import { Suspense } from "react";
import { VerifyOTPForm } from "./form";
import { redirect } from "next/navigation";
import { getSession } from "@cap/database/auth/session";

export const metadata = {
  title: "Verify Code | Cap",
};

export default async function VerifyOTPPage({
  searchParams,
}: {
  searchParams: { email?: string; next?: string };
}) {
  const session = await getSession();

  if (session?.user) {
    redirect(searchParams.next || "/dashboard");
  }

  if (!searchParams.email) {
    redirect("/login");
  }

  return (
    <div className="flex h-screen w-full items-center justify-center">
      <Suspense fallback={<div>Loading...</div>}>
        <VerifyOTPForm email={searchParams.email} next={searchParams.next} />
      </Suspense>
    </div>
  );
}