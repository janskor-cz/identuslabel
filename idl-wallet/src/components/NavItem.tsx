import React, { useState, useEffect } from 'react';

interface NavItemProps {
  icon: string;
  label: string;
  active?: boolean;
  badge?: string | number;
  collapsed?: boolean;
  onClick?: () => void;
}

export const NavItem: React.FC<NavItemProps> = ({ icon, label, active, badge, collapsed, onClick }) => {
  const [isActive, setIsActive] = useState(false);

  useEffect(() => {
    setIsActive(!!active);
  }, [active]);

  return (
    <button
      onClick={onClick}
      title={collapsed ? label : undefined}
      className={`w-full flex items-center ${collapsed ? 'justify-center px-0 py-3' : 'gap-3 px-4 py-3'} rounded-xl transition-all duration-200 group
        ${isActive
          ? 'bg-gradient-to-r from-cyan-500/20 to-purple-500/20 border border-cyan-500/30'
          : 'hover:bg-white/5 border border-transparent'}`}
    >
      <span className={`text-xl ${isActive ? 'text-cyan-400' : 'text-slate-400 group-hover:text-slate-300'}`}>
        {icon}
      </span>
      {!collapsed && (
        <span className={`flex-1 text-left text-sm font-medium ${isActive ? 'text-white' : 'text-slate-300'}`}>
          {label}
        </span>
      )}
      {!collapsed && badge && (
        <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
          {badge}
        </span>
      )}
    </button>
  );
};

export default NavItem;
