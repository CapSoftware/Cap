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

export function InfraOutOfCredit({
	email = "",
	appName = "",
	billingUrl = "",
	pausesOn = "",
}: {
	email: string;
	appName: string;
	billingUrl: string;
	pausesOn: string;
}) {
	return (
		<Html>
			<Head />
			<Preview>
				{`${appName} is out of Cap Infra credit. Playback pauses on ${pausesOn}.`}
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
							{appName} is out of credit
						</Heading>
						<Text className="text-sm leading-6 text-black">
							Today's storage charge for {appName} was more than its Cap Infra
							balance, so the balance is now zero.
						</Text>
						<Text className="text-sm leading-6 text-black">
							New uploads are blocked until you add credits. Your videos keep
							playing until {pausesOn}, then playback pauses. Nothing is
							deleted.
						</Text>
						<Section className="my-8 text-center">
							<Link
								className="rounded-full bg-black px-6 py-3 text-center text-[12px] font-semibold text-white no-underline"
								href={billingUrl}
							>
								Add credits
							</Link>
						</Section>
						<Text className="text-sm leading-6 text-black">
							Adding credits brings the app straight back. The days it could not
							pay for are not charged.
						</Text>
						<Footer email={email} />
					</Container>
				</Body>
			</Tailwind>
		</Html>
	);
}
