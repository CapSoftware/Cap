export const Window = ({ className }: { className: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <rect width="20" height="16" x="2" y="4" rx="2"></rect>
      <path d="M10 4v4M2 8h20M6 4v4"></path>
    </svg>
  );
};
