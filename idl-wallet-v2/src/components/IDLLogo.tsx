import React from 'react';

interface IDLLogoProps {
  size?: number;
}

export const IDLLogo: React.FC<IDLLogoProps> = ({ size = 40 }) => (
  <svg viewBox="0 0 200 220" width={size} xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="shieldGrad" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#dc2626"/>
        <stop offset="50%" stopColor="#f59e0b"/>
        <stop offset="100%" stopColor="#22c55e"/>
      </linearGradient>
      <linearGradient id="keyGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#00d4ff"/>
        <stop offset="100%" stopColor="#7c3aed"/>
      </linearGradient>
    </defs>
    <path d="M100 10 L180 40 L180 110 Q180 180 100 220 Q20 180 20 110 L20 40 Z"
          fill="none" stroke="url(#shieldGrad)" strokeWidth="12"/>
    <text x="100" y="65" textAnchor="middle" fill="#22c55e" fontSize="36" fontWeight="bold" fontFamily="Arial">I</text>
    <text x="100" y="110" textAnchor="middle" fill="#f59e0b" fontSize="36" fontWeight="bold" fontFamily="Arial">D</text>
    <text x="100" y="155" textAnchor="middle" fill="#dc2626" fontSize="36" fontWeight="bold" fontFamily="Arial">L</text>
    <circle cx="100" cy="185" r="12" fill="url(#keyGrad)"/>
  </svg>
);

export default IDLLogo;
