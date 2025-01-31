import { clientEnv, serverEnv } from "@cap/env";
import { JSXElementConstructor, ReactElement } from "react";
import { Resend } from "resend";

export const resend = serverEnv.RESEND_API_KEY
  ? new Resend(serverEnv.RESEND_API_KEY)
  : null;

export const sendEmail = async ({
  email,
  subject,
  react,
  marketing,
  test,
}: {
  email: string;
  subject: string;
  react: ReactElement<any, string | JSXElementConstructor<any>>;
  marketing?: boolean;
  test?: boolean;
}) => {
  if (!resend) {
    console.info(`Email to ${email} with subject ${subject} sent from Cap`);
    return Promise.resolve();
  }

  return resend.emails.send({
    from: marketing
      ? "Richie from Cap.so <richie@cap.so>"
      : clientEnv.NEXT_PUBLIC_IS_CAP
      ? "Cap Auth <no-reply@auth.cap.so>"
      : `auth@${clientEnv.NEXT_PUBLIC_WEB_URL}`,
    to: test ? "delivered@resend.dev" : email,
    subject,
    react,
  }) as any;
};
