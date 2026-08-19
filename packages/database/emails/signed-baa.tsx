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

export function SignedBaa({
	email = "",
	entityName = "",
	effectiveDate = "",
}: {
	email: string;
	entityName: string;
	effectiveDate: string;
}) {
	return (
		<Html>
			<Head />
			<Preview>
				Your Business Associate Agreement with Cap is signed and active
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
							Your signed BAA is attached
						</Heading>
						<Text className="text-sm leading-6 text-black">
							The Business Associate Agreement between {entityName} and Cap
							Software, Inc. has been executed, effective {effectiveDate}. A
							fully signed copy is attached to this email as a PDF for your
							records.
						</Text>
						<Text className="text-sm leading-6 text-black">
							The Signed BAA add-on is now active on your organization and bills
							at $99/month. You can download the signed agreement at any time
							from your organization's billing settings.
						</Text>
						<Text className="text-sm leading-6 text-black">
							If anything looks wrong, just reply to this email and we'll sort
							it out.
						</Text>
						<Footer email={email} />
					</Container>
				</Body>
			</Tailwind>
		</Html>
	);
}
