import React from "react";


interface BoxProps {
  children: React.ReactNode | React.ReactNode[];
  className?: string;
}

export const Box: React.FC<BoxProps> = ({ children, className = "" }) => {
  return (
    <div
      className={`w-full mt-5 p-6 bg-slate-800/30 border border-slate-700/50 rounded-2xl backdrop-blur-sm hover:bg-slate-800/40 transition-all duration-300 ${className}`}
    >
      {children}
    </div>
  );
}