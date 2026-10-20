import type { AirData } from './types'

export default function Chart({ data }: { data: AirData }) {
  if (data.hourly.length < 2) return <p className="small-note">Hourly forecast is unavailable.</p>
  const max = Math.max(5, ...data.hourly.map(p => p.pm25)) * 1.15
  const w = 320, h = 70
  const points = data.hourly.map((p, i) => `${(i / (data.hourly.length - 1)) * w},${h - (p.pm25 / max) * h}`)
  return <div className="forecast">
    <div className="section-label"><span>THE NEXT 24 HOURS</span><span>PM₂.₅ · µg/m³</span></div>
    <svg viewBox={`0 0 ${w} ${h + 5}`} role="img" aria-label={`PM2.5 forecast ranges from ${Math.min(...data.hourly.map(p => p.pm25)).toFixed(1)} to ${Math.max(...data.hourly.map(p => p.pm25)).toFixed(1)} micrograms per cubic meter.`}>
      <path d={`M0,${h} L${points.join(' L')} L${w},${h} Z`} fill="var(--accent)" opacity=".08" />
      <line x1="0" x2={w} y1={h} y2={h} stroke="var(--line)" strokeWidth="1" />
      <polyline points={points.join(' ')} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
      {data.hourly.map((p, i) => <circle key={p.time} cx={(i / (data.hourly.length - 1)) * w} cy={h - p.pm25 / max * h} r="4" fill="transparent"><title>{new Date(p.time).toLocaleString()}: {p.pm25.toFixed(1)} µg/m³ ({p.sample_count}/9 samples)</title></circle>)}
    </svg>
    <div className="chart-axis"><span>Now</span><span>+{Math.floor((data.hourly.length - 1) / 2)}h</span><span>+{data.hourly.length - 1}h</span></div>
  </div>
}
