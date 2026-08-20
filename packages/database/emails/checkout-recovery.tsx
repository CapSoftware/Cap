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

export function CheckoutRecovery({
	email = "",
	recoveryUrl = "",
	interval = null,
}: {
	email: string;
	recoveryUrl: string;
	interval?: "month" | "year" | null;
}) {
	return (
		<Html>
			<Head />
			<Preview>Your Cap Pro checkout is still waiting for you</Preview>
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
							You didn't finish upgrading
						</Heading>
						<Text className="text-sm leading-6 text-black">
							You started upgrading to Cap Pro but didn't get to the end. Your
							checkout is still here, so you can pick up exactly where you left
							off.
						</Text>
						<Section className="my-8 text-center">
							<Link
								className="rounded-full bg-black px-6 py-3 text-center text-[12px] font-semibold text-white no-underline"
								href={recoveryUrl}
							>
								Finish upgrading
							</Link>
						</Section>
						{interval === "month" ? (
							<Text className="text-sm leading-6 text-black">
								One thing worth knowing: the yearly plan works out a lot cheaper
								than paying monthly, and you can switch to it on the same
								checkout page.
							</Text>
						) : null}
						<Text className="text-sm leading-6 text-black">
							Pro gives you unlimited recording length, unlimited shareable
							links, Cap AI summaries and titles, custom domains, and password
							protected links.
						</Text>
						<Text className="text-sm leading-6 text-black">
							If you've changed your mind that's completely fine, you can ignore
							this email. If something went wrong at checkout, just reply and
							we'll sort it out.
						</Text>
						<Footer email={email} />
					</Container>
				</Body>
			</Tailwind>
		</Html>
	);
}

export default CheckoutRecovery;
