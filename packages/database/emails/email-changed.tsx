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

export function EmailChangedEmail({
	email = "",
	newEmail = "",
}: {
	email: string;
	newEmail: string;
}) {
	return (
		<Html>
			<Head />
			<Preview>Your Cap email address was changed</Preview>
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
							Your email address was changed
						</Heading>
						<Text className="text-sm leading-6 text-black">
							The email address for your Cap account was changed from {email} to{" "}
							{newEmail}. You sign in with the new address from now on.
						</Text>
						<Text className="text-sm leading-6 text-black">
							If you didn't make this change, reply to this email right away so
							we can help you secure your account.
						</Text>
						<Footer email={email} />
					</Container>
				</Body>
			</Tailwind>
		</Html>
	);
}
