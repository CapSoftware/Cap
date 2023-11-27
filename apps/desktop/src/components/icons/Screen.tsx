export const Screen = ({ className }: { className: string }) => {
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
      <rect width="20" height="14" x="2" y="3" rx="2"></rect>
      <path d="M8 21L16 21"></path>
      <path d="M12 17L12 21"></path>
    </svg>
  );
};
