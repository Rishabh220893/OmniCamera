import { ShieldCheck, Eye, BarChart2, Settings2, Map as MapIcon, BookOpen, LogOut } from 'lucide-react';
import { cn } from '../lib/utils';
import { TabId } from '../types';

interface SidebarProps {
  activeTab: TabId;
  onChangeTab: (tab: TabId) => void;
  onLogout: () => void;
}

export const NAV_ITEMS: { id: TabId; icon: typeof Eye; label: string }[] = [
  { id: 'monitor', icon: Eye, label: 'Feed' },
  { id: 'analytics', icon: BarChart2, label: 'Logs' },
  { id: 'map', icon: MapIcon, label: 'Registry' },
  { id: 'settings', icon: Settings2, label: 'Settings' },
  { id: 'guide', icon: BookOpen, label: 'Guide' },
];

export default function Sidebar({ activeTab, onChangeTab, onLogout }: SidebarProps) {
  return (
    <aside className="fixed left-0 top-0 bottom-0 w-24 hidden lg:flex flex-col items-center py-8 bg-surface border-r border-border z-50">
      <div className="w-11 h-11 rounded-2xl bg-accent flex items-center justify-center mb-10">
        <ShieldCheck className="w-6 h-6 text-white" strokeWidth={1.75} />
      </div>
      <nav className="flex flex-col gap-2">
        {NAV_ITEMS.map(tab => (
          <button
            key={tab.id}
            onClick={() => onChangeTab(tab.id)}
            title={tab.label}
            className={cn('nav-item !flex-col !gap-1.5 !px-2 !py-3 !w-[76px]', activeTab === tab.id && 'active')}
          >
            <tab.icon className="w-5 h-5" strokeWidth={1.75} />
            <span className="text-[10px] font-semibold leading-none">{tab.label}</span>
          </button>
        ))}
      </nav>
      <div className="mt-auto">
        <button
          onClick={onLogout}
          title="Logout"
          className="btn-ghost !px-3 !py-3 hover:!text-critical"
        >
          <LogOut className="w-5 h-5" strokeWidth={1.75} />
        </button>
      </div>
    </aside>
  );
}
