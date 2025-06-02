import { buildEnv, serverEnv } from "@cap/env";
import { JSXElementConstructor, ReactElement } from "react";
import { Resend } from "resend";

export const resend = () =>
  serverEnv().RESEND_API_KEY ? new Resend(serverEnv().RESEND_API_KEY) : null;

const resendCustomDomain = serverEnv().RESEND_FROM_DOMAIN

// Augment the CreateEmailOptions type to include scheduledAt
type EmailOptions = {
  from: string;
  to: string | string[];
  subject: string;
  react: ReactElement<any, string | JSXElementConstructor<any>>;
  scheduledAt?: string;
};

export const sendEmail = async ({
  email,
  subject,
  react,
  marketing,
  test,
  scheduledAt,
}: {
  email: string;
  subject: string;
  react: ReactElement<any, string | JSXElementConstructor<any>>;
  marketing?: boolean;
  test?: boolean;
  scheduledAt?: string;
}) => {
  const r = resend();
  if (!r) {
    return Promise.resolve();
  }

  let from: string | null = null;

  if (marketing) {
    from = "Richie from Cap <richie@send.cap.so>"
  } else if (buildEnv.NEXT_PUBLIC_IS_CAP) {
    from = "Cap Auth <no-reply@auth.cap.so>"
  } else if (resendCustomDomain) {
    from = `auth@${resendCustomDomain}`;
  } else if (buildEnv.NEXT_PUBLIC_WEB_URL) {
    const webUrl = new URL(buildEnv.NEXT_PUBLIC_WEB_URL);

    from = `auth@${webUrl.hostname}`;
  } else {
    throw new Error("No valid sender email configured");
  }

  return r.emails.send({
    from,
    to: test ? "delivered@resend.dev" : email,
    subject,
    react,
    scheduledAt,
  } as EmailOptions) as any;
};
