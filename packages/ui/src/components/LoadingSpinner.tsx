export const LoadingSpinner = ({
  size = 36,
  color = 'white',
  thickness = 3,
  speed = 1.5,
  className,
}: {
  size?: number;
  color?: string;
  thickness?: number;
  speed?: number;
  className?: string;
}) => {
  const spinnerStyle = {
    width: `${size}px`,
    minWidth: `${size}px`,
    height: `${size}px`,
    minHeight: `${size}px`,
    border: `${thickness}px solid rgba(255, 255, 255, 0.2)`,
    borderTop: `${thickness}px solid ${color}`,
    borderRadius: '50%',
    animation: `spin ${1 / speed}s linear infinite`
  };

  return (
    <>
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
      <div style={spinnerStyle} className={className} />
    </>
  );
};
