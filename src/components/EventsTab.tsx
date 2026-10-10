import { useState } from 'react';
import { motion } from 'motion/react';
import AlertsView from './events/AlertsView';
import EventsView from './events/EventsView';
import HealthView from './events/HealthView';
import RulesView from './events/RulesView';

type Section = 'events' | 'alerts' | 'rules' | 'health';
const SECTIONS: Array<{ id: Section; label: string }> = [{ id: 'events', label: 'Events' }, { id: 'alerts', label: 'Alerts' }, { id: 'rules', label: 'Rules' }, { id: 'health', label: 'Health' }];

/** Everything the analyzers, connected systems and gateways report, and what is done about it. */
export default function EventsTab() {
  const [section, setSection] = useState<Section>('events');
  const [openAlerts, setOpenAlerts] = useState<number | null>(null);
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} key="events" className="max-w-6xl mx-auto space-y-6 pb-20">
      <div className="space-y-1">
        <h2 className="text-xl font-bold font-display text-ink">Events</h2>
        <p className="text-sm text-ink-muted">Search what was detected, handle alerts, set the rules that raise them, and see whether every source is reporting.</p>
      </div>
      <div role="tablist" className="flex gap-1 border-b border-border">
        {SECTIONS.map((s) => (
          <button key={s.id} role="tab" aria-selected={section === s.id} onClick={() => setSection(s.id)}
            className={`px-4 py-2 text-sm font-semibold -mb-px border-b-2 transition-colors ${section === s.id ? 'border-accent text-accent' : 'border-transparent text-ink-muted hover:text-ink'}`}>
            {s.label}{s.id === 'alerts' && openAlerts ? <span className="badge badge-critical !text-[10px] ml-2">{openAlerts}</span> : null}
          </button>
        ))}
      </div>
      {section === 'events' && <EventsView />}
      {section === 'alerts' && <AlertsView onCount={setOpenAlerts} />}
      {section === 'rules' && <RulesView />}
      {section === 'health' && <HealthView />}
    </motion.div>
  );
}
