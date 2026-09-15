import type { EmailDefinition } from "../types";

export const customerUpdate = {
	id: "customer-update",
	key: "customer-update",
	purpose:
		"One-off Cap v0.6 launch announcement for customers, leading to the release video and update details.",
	subject: "Meet Cap v0.6, our biggest update yet",
	previewText:
		"3D scenes, animated titles and Studio Sound. See what's new in the launch video.",
	variables: ["capGreeting"],
	assets: ["emails/assets/cap-v06-player.jpg"],
	body: [
		"<Paragraph>{contact.capGreeting}</Paragraph>",
		"<Paragraph><Strong>Cap v0.6 is here, and it's our biggest release yet.</Strong></Paragraph>",
		`<Image src="img/cap-v06-player.jpg" alt="Watch the Cap v0.6 launch video" href="https://cap.so/blog/cap-v06?utm_source=loops&amp;utm_medium=email&amp;utm_campaign=cap_v06_launch&amp;utm_content=customers" />`,
		"<Paragraph>We've rebuilt the editor so you can do more with the recordings you already make. Add 3D scenes, animated titles and moving backgrounds, without opening another editing app.</Paragraph>",
		"<Paragraph>Studio Sound reduces microphone noise, and the new export screen shows estimated file size and time before you save.</Paragraph>",
		"<Paragraph>The easiest way to see the difference is the launch video. The release page also has the download and full details.</Paragraph>",
		`<Paragraph><Link href="https://cap.so/blog/cap-v06?utm_source=loops&amp;utm_medium=email&amp;utm_campaign=cap_v06_launch&amp;utm_content=customers">Watch Cap v0.6 in action →</Link></Paragraph>`,
		"<Paragraph>Thanks for supporting Cap. I can't wait to see what you make with this one :)</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
