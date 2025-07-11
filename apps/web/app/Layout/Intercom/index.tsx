import { getCurrentUser } from "@cap/database/auth/session";
import { serverEnv } from "@cap/env";
import { createHmac } from "node:crypto";
import { Client } from "./Client";
import { Suspense } from "react";

async function IntercomInner() {
  const user = await getCurrentUser();

  const intercomSecret = serverEnv().INTERCOM_SECRET;
  let hash;
  if (intercomSecret && user)
    hash = createHmac("sha256", intercomSecret).update(user.id).digest("hex");

  return <Client hash={hash} />;
}

export async function Intercom() {
  return (
    <Suspense>
      <IntercomInner />
    </Suspense>
  );
}
