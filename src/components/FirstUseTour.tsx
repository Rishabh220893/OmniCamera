import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Eye, Camera, Bell, X } from 'lucide-react';

interface FirstUseTourProps {
  onDismiss: () => void;
}

const STEPS = [
  { icon: Eye, title: 'This is your Live Grid', desc: 'Every camera you\'ve onboarded shows up here. Click a tile to focus it, or switch to grid view to watch several at once.' },
  { icon: Camera, title: 'Hit Activate to start analysis', desc: 'The Activate Guard button starts the AI analysis loop. In grid view, check a camera\'s box to run more than one at a time.' },
  { icon: Bell, title: 'Alerts land here automatically', desc: 'Anything genuinely suspicious — or a watchlist plate match — shows up in the Alert Center, no need to babysit every feed yourself.' },
];

// A first-time user (in a hackathon setting, often a judge) won't read docs —
// this proves the low learning curve in ~15 seconds instead of just hoping
// the UI is self-explanatory.
export default function FirstUseTour({ onDismiss }: FirstUseTourProps) {
  const [step, setStep] = useState(0);
  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }}
        className="fixed bottom-6 right-6 z-[150] w-[calc(100%-3rem)] max-w-sm card p-5 shadow-2xl border-accent/30"
      >
        <button onClick={onDismiss} className="absolute top-3 right-3 btn-ghost !p-1.5" title="Skip tour">
          <X className="w-3.5 h-3.5" strokeWidth={1.75} />
        </button>
        <div className="flex items-start gap-3 pr-6">
          <div className="w-10 h-10 rounded-xl bg-accent-soft flex items-center justify-center text-accent shrink-0">
            <current.icon className="w-5 h-5" strokeWidth={1.75} />
          </div>
          <div className="space-y-1">
            <h4 className="text-sm font-bold text-ink">{current.title}</h4>
            <p className="text-xs text-ink-muted leading-relaxed">{current.desc}</p>
          </div>
        </div>
        <div className="flex items-center justify-between mt-4">
          <div className="flex gap-1.5">
            {STEPS.map((_, i) => (
              <span key={i} className={`w-1.5 h-1.5 rounded-full ${i === step ? 'bg-accent' : 'bg-border'}`} />
            ))}
          </div>
          <button
            onClick={() => (isLast ? onDismiss() : setStep((s) => s + 1))}
            className="btn-primary !py-1.5 !px-4 text-xs"
          >
            {isLast ? 'Got it' : 'Next'}
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
