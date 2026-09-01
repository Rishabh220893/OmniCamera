import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend
} from 'recharts';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { CameraConfig, LogEntry } from '../types';

interface CameraTrendChartProps {
  camera: CameraConfig;
  logs: LogEntry[];
  /** Lets a click on a chart point jump straight to that reading in the
   *  Analytics log table instead of leaving the chart and table as two
   *  disconnected views of the same data. */
  onPointClick?: (logId: string) => void;
}

// Wider containers can fit more points before labels/lines get cramped —
// this keeps the visible time window proportional to the screen instead of
// a fixed count that's either too sparse on desktop or overlapping on mobile.
function usePointsPerPage(ref: React.RefObject<HTMLDivElement>): number {
  const [points, setPoints] = useState(10);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width || el.clientWidth;
      setPoints(Math.min(40, Math.max(6, Math.floor(width / 70))));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return points;
}

export default function CameraTrendChart({ camera, logs, onPointClick }: CameraTrendChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pointsPerPage = usePointsPerPage(containerRef);
  const [pageOffset, setPageOffset] = useState(0);

  const cameraLogs = useMemo(
    () => logs.filter((l) => l.cameraId === camera.id).slice().sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()),
    [logs, camera.id]
  );

  // A different camera's history has no relation to the previous scroll
  // position — jump back to the most recent window whenever it changes.
  useEffect(() => { setPageOffset(0); }, [camera.id]);

  const total = cameraLogs.length;
  const windowEnd = Math.max(0, total - pageOffset);
  const windowStart = Math.max(0, windowEnd - pointsPerPage);
  const visible = cameraLogs.slice(windowStart, windowEnd);

  const chartData = visible.map((log) => ({
    id: log.id,
    time: log.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    people: log.counts.people,
    vehicles: log.counts.vehicles,
  }));

  const canGoOlder = windowStart > 0;
  const canGoNewer = pageOffset > 0;

  return (
    <div className="card p-6 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-bold text-ink-muted uppercase tracking-widest">People &amp; vehicle trend — {camera.name}</h3>
          <p className="text-[11px] text-ink-muted mt-0.5">
            {total === 0 ? 'No analysis yet for this node.' : `Showing ${visible.length} of ${total} readings${onPointClick ? ' — click a point to open it in the log table' : ''}`}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => setPageOffset((o) => o + pointsPerPage)}
            disabled={!canGoOlder}
            title="Earlier"
            className="btn-ghost !p-2 !rounded-lg border border-border disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="w-4 h-4" strokeWidth={1.75} />
          </button>
          <button
            onClick={() => setPageOffset((o) => Math.max(0, o - pointsPerPage))}
            disabled={!canGoNewer}
            title="Later"
            className="btn-ghost !p-2 !rounded-lg border border-border disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronRight className="w-4 h-4" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <div ref={containerRef} className="h-[260px]">
        {chartData.length === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-ink-muted">
            Activate guard to start building this node's trend.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={chartData} margin={{ top: 4, right: 12, left: -12, bottom: 0 }}
              className={onPointClick ? 'cursor-pointer' : undefined}
              onClick={(state: { activePayload?: { payload: { id: string } }[] }) => {
                const id = state?.activePayload?.[0]?.payload?.id;
                if (id) onPointClick?.(id);
              }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="time" stroke="var(--color-ink-muted)" fontSize={9} tickLine={false} axisLine={false} />
              <YAxis stroke="var(--color-ink-muted)" fontSize={9} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip contentStyle={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: '12px' }} itemStyle={{ fontSize: 12, fontWeight: 600 }} labelStyle={{ fontSize: 10, color: 'var(--color-ink-muted)' }} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <ReferenceLine y={camera.peopleThreshold} stroke="#2f5fdd" strokeDasharray="4 4" label={{ value: 'People threshold', position: 'insideTopRight', fontSize: 9, fill: '#2f5fdd' }} />
              <ReferenceLine y={camera.vehicleThreshold} stroke="#1f8a5f" strokeDasharray="4 4" label={{ value: 'Vehicle threshold', position: 'insideBottomRight', fontSize: 9, fill: '#1f8a5f' }} />
              <Line type="monotone" dataKey="people" name="People" stroke="#2f5fdd" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
              <Line type="monotone" dataKey="vehicles" name="Vehicles" stroke="#1f8a5f" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
