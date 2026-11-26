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

export function PasskeyAddedEmail({
	email = "",
	passkeyName = "",
	settingsUrl = "",
}: {
	email: string;
	passkeyName: string;
	settingsUrl: string;
}) {
	return (
		<Html>
			<Head />
			<Preview>A passkey was added to your Cap account</Preview>
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
							New passkey added
						</Heading>
						<Text className="text-sm leading-6 text-black">
							A passkey ({passkeyName}) was just added to your Cap account. It
							can now be used to sign in.
						</Text>
						<Text className="text-sm leading-6 text-black">
							If this wasn't you, remove it from your{" "}
							<a href={settingsUrl} className="text-blue-600 underline">
								account settings
							</a>{" "}
							and sign out of all devices.
						</Text>
						<Footer email={email} />
					</Container>
				</Body>
			</Tailwind>
		</Html>
	);
}
