import { CAP_LOGO_URL } from "@cap/utils";
import {
	Body,
	Container,
	Head,
	Heading,
	Html,
	Img,
	Link,
	Section,
	Tailwind,
	Text,
} from "@react-email/components";
import Footer from "./components/Footer";

export function FirstShareableLink({
	email = "",
	url = "",
	videoName = "",
}: {
	email: string;
	url: string;
	videoName: string;
}) {
	return (
		<Html>
			<Head />
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
							You created your first Cap link! 🥳
						</Heading>
						<Text className="text-sm leading-6 text-black">
							Your video "{videoName}" is now ready to share with anyone.
						</Text>
						<Text className="text-sm leading-6 text-black">
							Click the button below to view your Cap and share it with others.
						</Text>
						<Section className="my-8 text-center">
							<Link
								className="rounded-full bg-black px-6 py-3 text-center text-[12px] font-semibold text-white no-underline"
								href={url}
							>
								View Your Cap
							</Link>
						</Section>
						<Text className="text-sm leading-6 text-black">
							or copy and paste this URL into your browser:
						</Text>
						<Text className="max-w-sm flex-wrap break-words font-medium text-purple-600 no-underline">
							{url.replace(/^https?:\/\//, "")}
						</Text>
						<Text className="text-sm leading-6 text-black mt-6">
							With Cap, you can easily share your screen recordings, get
							feedback, and collaborate with others. We're excited to see what
							you create!
						</Text>
						<Footer email={email} marketing={true} />
					</Container>
				</Body>
			</Tailwind>
		</Html>
	);
}
