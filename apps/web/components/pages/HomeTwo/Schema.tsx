import { homepageSchema } from "./seo";

export const HomeTwoSchema = () => (
	<script type="application/ld+json">
		{JSON.stringify(homepageSchema).replace(/</g, "\\u003c")}
	</script>
);
