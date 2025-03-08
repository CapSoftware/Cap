import { clientEnv, serverEnv } from "@cap/env";
import { JSXElementConstructor, ReactElement } from "react";
import { Resend } from "resend";

export const resend = serverEnv.RESEND_API_KEY
  ? new Resend(serverEnv.RESEND_API_KEY)
  : null;

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
  if (!resend) {
    return Promise.resolve();
  }

  return resend.emails.send({
    from: marketing
      ? "Richie from Cap <richie@send.cap.so>"
      : clientEnv.NEXT_PUBLIC_IS_CAP
      ? "Cap Auth <no-reply@auth.cap.so>"
      : `auth@${clientEnv.NEXT_PUBLIC_WEB_URL}`,
    to: test ? "delivered@resend.dev" : email,
    subject,
    react,
    scheduledAt,
  } as EmailOptions) as any;
};
