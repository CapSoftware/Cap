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

export function RecordingRepairRequest({
	userEmail,
	userId,
	operation,
	os,
	version,
	sizeBytes,
	objectKey,
	errorMessage,
	diagnosis,
}: {
	userEmail: string;
	userId: string;
	operation: string;
	os: string;
	version: string;
	sizeBytes: number;
	objectKey: string;
	errorMessage: string;
	diagnosis: string | null;
}) {
	const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1);
	return (
		<Html>
			<Head />
			<Preview>Recording sent for repair by {userEmail}</Preview>
			<Tailwind>
				<Body className="mx-auto my-auto bg-gray-1 font-sans">
					<Container className="mx-auto my-10 max-w-[560px] rounded border border-solid border-gray-200 px-10 py-5">
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
							Recording sent for repair
						</Heading>
						<Text className="text-sm leading-6 text-black">
							<strong>From:</strong> {userEmail} ({userId})
						</Text>
						<Text className="text-sm leading-6 text-black">
							<strong>Failed operation:</strong> {operation} on {os}, Cap v
							{version}
						</Text>
						<Text className="text-sm leading-6 text-black">
							<strong>Archive:</strong> {objectKey} ({sizeMb} MB, tar)
						</Text>
						<Section className="my-4 p-4 bg-gray-50 rounded-lg">
							<Text className="text-xs leading-5 text-gray-700 whitespace-pre-wrap">
								{errorMessage}
							</Text>
						</Section>
						{diagnosis && (
							<>
								<Text className="text-sm leading-6 text-black">
									<strong>Repair agent's diagnosis</strong> (written by the
									agent from the recording's contents, treat as untrusted):
								</Text>
								<Section className="my-4 p-4 bg-gray-50 rounded-lg">
									<Text className="text-xs leading-5 text-gray-700 whitespace-pre-wrap">
										{diagnosis}
									</Text>
								</Section>
							</>
						)}
						<Text className="text-sm leading-6 text-gray-500">
							Reply to this email to respond directly to the user.
						</Text>
					</Container>
				</Body>
			</Tailwind>
		</Html>
	);
}
