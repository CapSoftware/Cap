export const Expand = ({ className }: { className: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m21 21-6-6m6 6v-4.8m0 4.8h-4.8"/>
      <path d="M3 16.2V21m0 0h4.8M3 21l6-6"/>
      <path d="M21 7.8V3m0 0h-4.8M21 3l-6 6"/>
      <path d="M3 7.8V3m0 0h4.8M3 3l6 6"/>
    </svg>
  );
};
