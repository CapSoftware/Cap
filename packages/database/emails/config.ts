import { clientEnv, serverEnv } from "@cap/env";
import { eq } from "drizzle-orm";
import { db } from "../index";
import { JSXElementConstructor, ReactElement } from "react";
import { Resend } from "resend";
import { serverConfigTable } from "../schema";

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
    console.info(
      `❌ Could not send email to ${email} with subject ${subject} sent from Cap`
    );
    return Promise.resolve();
  }

  const sendFrom = async () => {
    if (marketing) {
      return "Richie from Cap.so <richie@cap.so>";
    }

    if (clientEnv.NEXT_PUBLIC_IS_CAP) {
      return "Cap Auth <no-reply@auth.cap.so>";
    }

    const serverConfigResponse = await db.query.serverConfigTable.findFirst({
      where: eq(serverConfigTable.id, 1),
    });

    if (
      serverConfigResponse &&
      serverConfigResponse.emailSendFromName &&
      serverConfigResponse.emailSendFromEmail
    ) {
      return `${serverConfigResponse.emailSendFromName} <${serverConfigResponse.emailSendFromEmail}>`;
    }

    return `auth@${clientEnv.NEXT_PUBLIC_WEB_URL}`;
  };

  return resend.emails.send({
    from: await sendFrom(),
    to: test ? "delivered@resend.dev" : email,
    subject,
    react,
  }) as any;
};
