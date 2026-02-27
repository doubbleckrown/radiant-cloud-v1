import { useEffect, useRef, useState } from "react";
import api from "../../utils/api";

// Minimal inline sparkline (no external lib needed — pure SVG path)
export default function SparklineChart({ instrument, width = 80, height = 32 }) {
  const [points, setPoints] = useState([]);
  const [trend, setTrend]   = useState(null); // "up" | "down" | null

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { data } = await api.get(`/markets/${instrument}/candles?granularity=M15`);
        if (cancelled) return;
        const closes = data.slice(-24).map((c) => c.c);
        if (closes.length < 2) return;
        setPoints(closes);
        setTrend(closes[closes.length - 1] > closes[0] ? "up" : "down");
      } catch {
        // silent — chart is decorative
      }
    };
    load();
    return () => { cancelled = true; };
  }, [instrument]);

  if (points.length < 2) {
    return <div style={{ width, height }} className="opacity-20 bg-void-200 rounded" />;
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;

  const svgPoints = points.map((p, i) => {
    const x = (i / (points.length - 1)) * width;
    const y = height - ((p - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  });

  const pathD = "M" + svgPoints.join(" L");
  const areaD = pathD + ` L${width},${height} L0,${height} Z`;
  const color  = trend === "up" ? "#00FF41" : "#FF3A3A";
  const gradId = `grad-${instrument}`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow: "visible" }}>
      <defs>
        <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Area fill */}
      <path d={areaD} fill={`url(#${gradId})`} />
      {/* Line */}
      <path
        d={pathD}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ filter: `drop-shadow(0 0 3px ${color}80)` }}
      />
      {/* Last dot */}
      <circle
        cx={svgPoints[svgPoints.length - 1].split(",")[0]}
        cy={svgPoints[svgPoints.length - 1].split(",")[1]}
        r="2"
        fill={color}
        style={{ filter: `drop-shadow(0 0 4px ${color})` }}
      />
    </svg>
  );
}