export const Focus = ({ className }: { className: string }) => {
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
      <path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"></path>
      <circle cx="12" cy="12" r="1"></circle>
      <path d="M5 12s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5"></path>
    </svg>
  );
};
