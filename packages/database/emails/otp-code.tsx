import { CAP_LOGO_URL } from "@cap/utils";
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Img,
  Preview,
  Section,
  Tailwind,
  Text,
} from "@react-email/components";
import Footer from "./components/Footer";

export function OtpCode({
  email = "",
  code = "",
}: {
  email: string;
  code: string;
}) {
  return (
    <Html>
      <Head />
      <Preview>Your Cap verification code: {code}</Preview>
      <Tailwind>
        <Body className="mx-auto my-auto bg-gray-1 font-sans">
          <Container className="mx-auto my-10 max-w-[500px] rounded border border-solid border-gray-200 px-10 py-5">
            <Section className="mt-8">
              <Img
                src={CAP_LOGO_URL}
                width="40"
                height="40"
                alt="Cap"
                className="mx-auto my-0"
              />
            </Section>
            <Heading className="mx-0 my-7 p-0 text-center text-xl font-semibold text-black">
              Your verification code
            </Heading>
            <Text className="text-sm leading-6 text-black text-center">
              Welcome to Cap! Use this code to complete your sign in:
            </Text>
            <Section className="my-8 text-center">
              <div className="mx-auto px-8 py-6 bg-gray-50 rounded-lg max-w-fit">
                <Text className="text-4xl font-mono font-bold text-black m-0 tracking-widest">
                  {code}
                </Text>
              </div>
            </Section>
            <Text className="text-sm leading-6 text-gray-600 text-center">
              This code will expire in 10 minutes.
            </Text>
            <Text className="text-sm leading-6 text-gray-600 text-center">
              If you didn't request this code, you can safely ignore this email.
            </Text>
            <Footer email={email} />
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
