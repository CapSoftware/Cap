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

export function OrganizationInvite({
	email = "",
	url = "",
	organizationName = "",
}: {
	email: string;
	url: string;
	organizationName: string;
}) {
	return (
		<Html>
			<Head />
			<Preview>Invitation to join {organizationName} on Cap</Preview>
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
							You're invited to join {organizationName}
						</Heading>
						<Text className="text-sm leading-6 text-black">Hello,</Text>
						<Text className="text-sm leading-6 text-black">
							You've been invited to join the {organizationName} organization on
							Cap. Click the button below to accept the invitation and join the
							team.
						</Text>
						<Section className="my-8 text-center">
							<Link
								className="rounded-full bg-black px-6 py-3 text-center text-[12px] font-semibold text-white no-underline"
								href={url}
							>
								Join Organization
							</Link>
						</Section>
						<Text className="text-sm leading-6 text-black">
							or copy and paste this URL into your browser:
						</Text>
						<Text className="max-w-sm flex-wrap break-words font-medium text-purple-600 no-underline">
							{url.replace(/^https?:\/\//, "")}
						</Text>
						<Footer email={email} />
					</Container>
				</Body>
			</Tailwind>
		</Html>
	);
}
