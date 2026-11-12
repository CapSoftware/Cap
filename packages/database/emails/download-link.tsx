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

const LINKS = [
	{ label: "Download for Mac (Apple Silicon)", platform: "apple-silicon" },
	{ label: "Download for Mac (Intel)", platform: "apple-intel" },
	{ label: "Download for Windows", platform: "windows" },
	{ label: "Download for Linux (.deb)", platform: "linux-deb" },
];

const PRIMARY_LINK =
	"block w-full rounded-lg bg-black px-6 py-3 text-center text-[13px] font-semibold text-white no-underline";
const SECONDARY_LINK =
	"block w-full rounded-lg border border-solid border-gray-300 bg-white px-6 py-3 text-center text-[13px] font-semibold text-black no-underline";

export function DownloadLink({ email = "" }: { email: string }) {
	return (
		<Html>
			<Head />
			<Preview>Open this on your computer to install Cap.</Preview>
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
							Your Cap download link
						</Heading>
						<Text className="text-sm leading-6 text-black">
							Open this email on your computer and pick your platform. Cap
							downloads straight away and the page walks you through installing
							it.
						</Text>

						<Section className="my-6">
							<table cellPadding="0" cellSpacing="0" style={{ width: "100%" }}>
								{LINKS.map((link, index) => (
									<tr key={link.platform}>
										<td
											style={{
												paddingBottom:
													index === LINKS.length - 1 ? undefined : "12px",
											}}
										>
											<Link
												className={index === 0 ? PRIMARY_LINK : SECONDARY_LINK}
												href={`https://cap.so/download/started?platform=${link.platform}`}
											>
												{link.label}
											</Link>
										</td>
									</tr>
								))}
							</table>
						</Section>

						<Text className="mt-4 text-sm leading-6 text-black">
							On another setup? Every version is at{" "}
							<Link href="https://cap.so/download" className="text-black">
								cap.so/download
							</Link>
							.
						</Text>
						<Footer email={email} marketing={true} />
					</Container>
				</Body>
			</Tailwind>
		</Html>
	);
}
