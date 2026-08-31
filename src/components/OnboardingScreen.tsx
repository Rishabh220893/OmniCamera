import { motion } from 'motion/react';
import { ShieldCheck, Eye, Bell, Lock } from 'lucide-react';

interface OnboardingScreenProps {
  onComplete: () => void;
}

const FEATURES = [
  { icon: Eye, title: 'AI Monitoring', desc: 'Real-time object and behavior detection' },
  { icon: Bell, title: 'Smart Alerts', desc: 'Get notified via webhooks only when it matters' },
  { icon: Lock, title: 'Privacy First', desc: 'Frame analysis runs server-side, never in your browser' }
];

export default function OnboardingScreen({ onComplete }: OnboardingScreenProps) {
  return (
    <motion.div
      key="onboarding"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, y: -20 }}
      className="fixed inset-0 z-[200] bg-surface flex flex-col items-center justify-center p-6 text-center"
    >
      <div className="max-w-md space-y-10">
        <div className="space-y-5">
          <div className="w-16 h-16 rounded-2xl bg-accent-soft mx-auto flex items-center justify-center">
            <ShieldCheck className="w-8 h-8 text-accent" strokeWidth={1.75} />
          </div>
          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-tight text-ink">OmniSee <span className="text-accent">Pro</span></h1>
            <p className="text-ink-muted">Enterprise AI vision for your home or business.</p>
          </div>
        </div>

        <div className="space-y-3 text-left">
          {FEATURES.map((item, idx) => (
            <motion.div
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.15 + idx * 0.08 }}
              key={item.title}
              className="card flex items-center gap-4 p-4"
            >
              <div className="w-10 h-10 rounded-xl bg-accent-soft flex items-center justify-center text-accent shrink-0">
                <item.icon className="w-5 h-5" strokeWidth={1.75} />
              </div>
              <div>
                <h4 className="text-sm font-semibold text-ink">{item.title}</h4>
                <p className="text-xs text-ink-muted">{item.desc}</p>
              </div>
            </motion.div>
          ))}
        </div>

        <button onClick={onComplete} className="btn-primary w-full py-4 text-base">
          Get Started
        </button>
      </div>
    </motion.div>
  );
}
