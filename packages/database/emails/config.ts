import { buildEnv, serverEnv } from "@cap/env";
import { JSXElementConstructor, ReactElement } from "react";
import { Resend } from "resend";

export const resend = () =>
  serverEnv().RESEND_API_KEY ? new Resend(serverEnv().RESEND_API_KEY) : null;

const resendCustomDomain = serverEnv().RESEND_FROM_DOMAIN ? serverEnv().RESEND_FROM_DOMAIN : buildEnv.NEXT_PUBLIC_WEB_URL

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

  return r.emails.send({
    from: marketing
      ? "Richie from Cap <richie@send.cap.so>"
      : buildEnv.NEXT_PUBLIC_IS_CAP
      ? "Cap Auth <no-reply@auth.cap.so>"
      : `auth@${resendCustomDomain}`,
    to: test ? "delivered@resend.dev" : email,
    subject,
    react,
    scheduledAt,
  } as EmailOptions) as any;
};
