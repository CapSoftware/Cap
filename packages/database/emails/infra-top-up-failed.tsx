import { CAP_LOGO_URL } from "@cap/utils";
import {
	Body,
	Container,
	Head,
	Heading,
	Html,
	Img,
	Link,
	Preview,
	Section,
	Tailwind,
	Text,
} from "@react-email/components";
import Footer from "./components/Footer";

export function InfraTopUpFailed({
	email = "",
	appName = "",
	billingUrl = "",
	amount = "",
}: {
	email: string;
	appName: string;
	billingUrl: string;
	amount: string;
}) {
	return (
		<Html>
			<Head />
			<Preview>
				{`The ${amount} auto top-up for ${appName} was declined, so auto top-up is off.`}
			</Preview>
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
							Your auto top-up didn't go through
						</Heading>
						<Text className="text-sm leading-6 text-black">
							We tried to charge your saved card {amount} to top up {appName} on
							Cap Infra and the payment was declined. No credit was added.
						</Text>
						<Text className="text-sm leading-6 text-black">
							Auto top-up is now switched off for this app so the card is not
							charged again. Add credits or save a different card, then switch
							it back on.
						</Text>
						<Section className="my-8 text-center">
							<Link
								className="rounded-full bg-black px-6 py-3 text-center text-[12px] font-semibold text-white no-underline"
								href={billingUrl}
							>
								Open billing
							</Link>
						</Section>
						<Footer email={email} />
					</Container>
				</Body>
			</Tailwind>
		</Html>
	);
}
