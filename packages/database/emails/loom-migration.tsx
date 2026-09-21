import {
	Body,
	Container,
	Head,
	Heading,
	Html,
	Link,
	Preview,
	Text,
} from "@react-email/components";

export function LoomMigrationRequestEmail({
	organizationName,
	requesterEmail,
	workspaceName,
	queueUrl,
}: {
	organizationName: string;
	requesterEmail: string;
	workspaceName: string | null;
	queueUrl: string;
}) {
	return (
		<Html>
			<Head />
			<Preview>New Loom migration request from {organizationName}</Preview>
			<Body className="bg-white font-sans">
				<Container className="mx-auto my-10 max-w-[500px] px-6">
					<Heading>New Loom migration request</Heading>
					<Text>
						{organizationName} requested a Cap Pro concierge migration.
					</Text>
					<Text>Requested by: {requesterEmail}</Text>
					{workspaceName && <Text>Loom workspace: {workspaceName}</Text>}
					<Link href={queueUrl}>Open the migration queue</Link>
				</Container>
			</Body>
		</Html>
	);
}

export function LoomMigrationStatusEmail({
	organizationName,
	statusLabel,
	message,
	dashboardUrl,
}: {
	organizationName: string;
	statusLabel: string;
	message: string | null;
	dashboardUrl: string;
}) {
	return (
		<Html>
			<Head />
			<Preview>Your Loom migration is {statusLabel.toLowerCase()}</Preview>
			<Body className="bg-white font-sans">
				<Container className="mx-auto my-10 max-w-[500px] px-6">
					<Heading>Loom migration update</Heading>
					<Text>
						Your migration for {organizationName} is {statusLabel.toLowerCase()}
						.
					</Text>
					{message && <Text>{message}</Text>}
					<Link href={dashboardUrl}>View your migration</Link>
				</Container>
			</Body>
		</Html>
	);
}
