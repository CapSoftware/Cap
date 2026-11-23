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

export function EmailChangeCodeEmail({
	email = "",
	code = "",
}: {
	email: string;
	code: string;
}) {
	return (
		<Html>
			<Head />
			<Preview>Confirm your new Cap email address: {code}</Preview>
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
							Confirm your new email
						</Heading>
						<Text className="text-sm leading-6 text-black">
							Enter this code in Cap to make this the email address for your
							account:
						</Text>
						<Section className="my-8 text-center">
							<div className="rounded-lg bg-gray-100 px-8 py-6">
								<Text className="m-0 text-3xl font-bold tracking-wider text-black">
									{code}
								</Text>
							</div>
						</Section>
						<Text className="text-sm leading-6 text-black">
							This code expires in 10 minutes. If you didn't ask for this, you
							can ignore this email and nothing will change.
						</Text>
						<Footer email={email} />
					</Container>
				</Body>
			</Tailwind>
		</Html>
	);
}
