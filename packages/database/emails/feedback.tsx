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

export function Feedback({
	userEmail = "",
	feedback = "",
	os,
	version,
}: {
	userEmail: string;
	feedback: string;
	os?: string;
	version?: string;
}) {
	return (
		<Html>
			<Head />
			<Preview>New feedback from {userEmail}</Preview>
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
							New User Feedback
						</Heading>
						<Text className="text-sm leading-6 text-black">
							<strong>From:</strong> {userEmail}
						</Text>
						{(os || version) && (
							<Text className="text-sm leading-6 text-black">
								<strong>Platform:</strong> {os || "Unknown"}{" "}
								{version ? `v${version}` : ""}
							</Text>
						)}
						<Section className="my-4 p-4 bg-gray-50 rounded-lg">
							<Text className="text-sm leading-6 text-gray-700 whitespace-pre-wrap">
								{feedback}
							</Text>
						</Section>
						<Text className="text-sm leading-6 text-gray-500">
							Reply to this email to respond directly to the user.
						</Text>
					</Container>
				</Body>
			</Tailwind>
		</Html>
	);
}
