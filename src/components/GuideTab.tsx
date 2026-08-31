import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Search, BookOpen, ListChecks } from 'lucide-react';
import { GLOSSARY_TERMS, OPERATING_STEPS, GlossaryTerm } from '../data/glossary';

const CATEGORIES: GlossaryTerm['category'][] = ['Camera Setup', 'Detection', 'Alerts & Security', 'Registry & GIS', 'Data & Export'];

export default function GuideTab() {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GLOSSARY_TERMS;
    return GLOSSARY_TERMS.filter(t => t.term.toLowerCase().includes(q) || t.definition.toLowerCase().includes(q));
  }, [query]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
      key="guide" className="max-w-5xl mx-auto space-y-10 pb-20"
    >
      <div className="space-y-1">
        <h2 className="text-xl font-bold text-ink">Guide</h2>
        <p className="text-sm text-ink-muted">How OmniSee works, and what everything on screen means.</p>
      </div>

      <section className="card p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-accent-soft flex items-center justify-center text-accent">
            <ListChecks className="w-5 h-5" strokeWidth={1.75} />
          </div>
          <div>
            <h3 className="text-base font-bold text-ink">Operating OmniSee</h3>
            <p className="text-xs text-ink-muted">A first-run walkthrough, start to finish.</p>
          </div>
        </div>
        <ol className="space-y-5">
          {OPERATING_STEPS.map(step => (
            <li key={step.step} className="flex gap-4">
              <div className="w-7 h-7 rounded-full bg-surface-muted border border-border flex items-center justify-center text-xs font-bold text-ink shrink-0">
                {step.step}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h4 className="text-sm font-semibold text-ink">{step.title}</h4>
                  <span className="badge badge-neutral !normal-case">{step.tab}</span>
                </div>
                <p className="text-xs text-ink-muted mt-1 leading-relaxed max-w-2xl">{step.description}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="card p-8">
        <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-accent-soft flex items-center justify-center text-accent">
              <BookOpen className="w-5 h-5" strokeWidth={1.75} />
            </div>
            <div>
              <h3 className="text-base font-bold text-ink">Glossary</h3>
              <p className="text-xs text-ink-muted">Terms used across the dashboard.</p>
            </div>
          </div>
          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 text-ink-muted absolute left-3.5 top-1/2 -translate-y-1/2" strokeWidth={1.75} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search terms..."
              className="input !pl-10 !py-2.5 text-sm"
            />
          </div>
        </div>

        <div className="space-y-8">
          {CATEGORIES.map(cat => {
            const terms = filtered.filter(t => t.category === cat);
            if (terms.length === 0) return null;
            return (
              <div key={cat}>
                <h4 className="text-[10px] font-bold text-ink-muted uppercase tracking-widest mb-3">{cat}</h4>
                <div className="grid sm:grid-cols-2 gap-3">
                  {terms.map(t => (
                    <div key={t.term} className="panel p-4">
                      <h5 className="text-sm font-bold text-ink mb-1">{t.term}</h5>
                      <p className="text-xs text-ink-muted leading-relaxed">{t.definition}</p>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <p className="text-sm text-ink-muted text-center py-8">No terms match "{query}".</p>
          )}
        </div>
      </section>
    </motion.div>
  );
}
