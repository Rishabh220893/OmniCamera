import { motion } from 'motion/react';
import { cn } from '../lib/utils';
import { TabId } from '../types';
import { NAV_ITEMS } from './Sidebar';

interface MobileNavProps {
  activeTab: TabId;
  onChangeTab: (tab: TabId) => void;
}

export default function MobileNav({ activeTab, onChangeTab }: MobileNavProps) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 h-16 bg-surface border-t border-border flex lg:hidden items-center justify-around z-50 px-1">
      {NAV_ITEMS.map(tab => (
        <button
          key={tab.id}
          onClick={() => onChangeTab(tab.id)}
          className={cn(
            'flex flex-col items-center justify-center gap-1 w-full h-full relative transition-colors',
            activeTab === tab.id ? 'text-accent' : 'text-ink-muted'
          )}
        >
          <tab.icon className="w-5 h-5" strokeWidth={1.75} />
          <span className="text-[9px] font-semibold uppercase tracking-wide">{tab.label}</span>
          {activeTab === tab.id && (
            <motion.div layoutId="mobile-nav-pill" className="absolute top-0 w-8 h-0.5 bg-accent rounded-b-full" />
          )}
        </button>
      ))}
    </nav>
  );
}
