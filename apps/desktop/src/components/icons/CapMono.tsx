export const CapMono = ({ className }: { className: string }) => {
  return (
    <svg
      className={className}
      viewBox="0 0 1022 1022"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="511" cy="511" r="511" fill="url(#paint0_radial_142_55)" />
      <circle
        cx="512.62"
        cy="512.62"
        r="434.756"
        fill="url(#paint1_linear_142_55)"
      />
      <circle
        cx="512.621"
        cy="512.619"
        r="327.689"
        fill="url(#paint2_radial_142_55)"
      />
      <defs>
        <radialGradient
          id="paint0_radial_142_55"
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(511 333.975) rotate(107.38) scale(720.94)"
        >
          <stop offset="0.0625" />
          <stop offset="0.411458" stop-color="#1C1C1C" />
          <stop offset="0.90625" stop-color="#0B0B0B" />
        </radialGradient>
        <linearGradient
          id="paint1_linear_142_55"
          x1="512.62"
          y1="77.8643"
          x2="512.62"
          y2="947.375"
          gradientUnits="userSpaceOnUse"
        >
          <stop stop-color="#424445" />
          <stop offset="1" stop-color="#949494" />
        </linearGradient>
        <radialGradient
          id="paint2_radial_142_55"
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(562.083 512.619) rotate(98.5836) scale(331.401)"
        >
          <stop stop-color="#F3F3F3" />
          <stop offset="1" stop-color="#DCDCDC" />
        </radialGradient>
      </defs>
    </svg>
  );
};
