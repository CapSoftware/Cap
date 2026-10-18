import { faGithub } from "@fortawesome/free-brands-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

export const GithubIcon = ({ className }: { className?: string }) => (
	<FontAwesomeIcon icon={faGithub} className={className} />
);
