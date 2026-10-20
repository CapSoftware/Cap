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

export function PaymentFailed({
	email = "",
	billingUrl = "",
	nextRetryDate = null,
	finalAttempt = false,
}: {
	email: string;
	billingUrl: string;
	nextRetryDate?: string | null;
	finalAttempt?: boolean;
}) {
	return (
		<Html>
			<Head />
			<Preview>
				{finalAttempt
					? "Your Cap Pro subscription will be canceled unless we can collect payment"
					: "We could not collect your Cap Pro payment. Your access is unaffected while we retry."}
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
							{finalAttempt
								? "Last chance to keep Cap Pro"
								: "Your payment didn't go through"}
						</Heading>
						<Text className="text-sm leading-6 text-black">
							We tried to charge your card for Cap Pro but the payment failed.
							This is usually an expired card or a one-off bank decline.
						</Text>
						{finalAttempt ? (
							<Text className="text-sm leading-6 text-black">
								This was our last automatic retry. If the payment can't be
								collected, your subscription will be canceled and you'll lose
								Pro features like unlimited recording length, Cap AI, and custom
								domains.
							</Text>
						) : (
							<Text className="text-sm leading-6 text-black">
								Your Pro features are still active
								{nextRetryDate
									? `, and we'll automatically retry on ${nextRetryDate}`
									: ", and we'll retry automatically"}
								. The quickest fix is updating your payment method:
							</Text>
						)}
						<Section className="my-8 text-center">
							<Link
								className="rounded-full bg-black px-6 py-3 text-center text-[12px] font-semibold text-white no-underline"
								href={billingUrl}
							>
								Update payment method
							</Link>
						</Section>
						<Text className="text-sm leading-6 text-black">
							If you've already updated your card, you can ignore this email.
							Reply if anything looks wrong and we'll sort it out.
						</Text>
						<Footer email={email} />
					</Container>
				</Body>
			</Tailwind>
		</Html>
	);
}
