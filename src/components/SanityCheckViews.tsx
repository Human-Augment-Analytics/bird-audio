import { useState, useMemo } from "react";
import type { ExportedEvent } from "../types";

interface Props {
  events: ExportedEvent[];
}

type TabType = "elevation" | "timeline" | "sites";
type ElevationData = Record<
  "Low" | "Medium" | "High",
  { stats: ReturnType<typeof calculateBoxStats>; raw: number[] }
>;
interface TimelineBin {
  start: number;
  end: number;
  count: number;
}
interface TimelineData {
  bins: TimelineBin[];
  formatType: "absolute" | "relative";
  minTime?: number;
  binSizeMs?: number;
}

// Extractor helpers matching Rust logic
function findDeviceId(path: string): string | null {
  const matchPS = path.match(/PS[LMH]\d+/i);
  if (matchPS) {
    return matchPS[0].toUpperCase();
  }
  const matchH = path.match(/(?:^|[^a-zA-Z0-9])(H\d+)/i);
  if (matchH) {
    return matchH[1].toUpperCase();
  }
  return null;
}

function getElevationBand(deviceId: string | null): "Low" | "Medium" | "High" | "Unknown" {
  if (!deviceId) return "Unknown";
  if (deviceId.startsWith("PSL")) return "Low";
  if (deviceId.startsWith("PSM")) return "Medium";
  if (deviceId.startsWith("PSH") || deviceId.startsWith("H")) return "High";
  return "Unknown";
}

function parseSessionDatetime(path: string): Date | null {
  const match = path.match(/(\d{8})_(\d{6})/);
  if (!match) return null;
  const dateStr = match[1];
  const timeStr = match[2];
  const year = parseInt(dateStr.substring(0, 4));
  const month = parseInt(dateStr.substring(4, 6)) - 1;
  const day = parseInt(dateStr.substring(6, 8));
  const hour = parseInt(timeStr.substring(0, 2));
  const minute = parseInt(timeStr.substring(2, 4));
  const second = parseInt(timeStr.substring(4, 6));
  return new Date(year, month, day, hour, minute, second);
}

function calculateBoxStats(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  const getPercentile = (p: number) => {
    const idx = (sorted.length - 1) * p;
    const base = Math.floor(idx);
    const rest = idx - base;
    if (sorted[base + 1] !== undefined) {
      return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    }
    return sorted[base];
  };

  const q1 = getPercentile(0.25);
  const median = getPercentile(0.5);
  const q3 = getPercentile(0.75);
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;

  return { min, q1, median, q3, max, mean, count: values.length };
}

function getMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

export default function SanityCheckViews({ events }: Props) {
  const [activeTab, setActiveTab] = useState<TabType>("elevation");
  const [siteSortBy, setSiteSortBy] = useState<"site" | "count" | "meanDuration" | "medianFreq">("count");
  const [siteSortAsc, setSiteSortAsc] = useState<boolean>(false);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    title: string;
    content: string[];
    show: boolean;
  }>({ x: 0, y: 0, title: "", content: [], show: false });

  // Compute Elevation Box Stats
  const elevationData = useMemo(() => {
    const bands: Record<"Low" | "Medium" | "High", number[]> = {
      Low: [],
      Medium: [],
      High: [],
    };

    events.forEach((e) => {
      const dev = findDeviceId(e.path);
      const band = getElevationBand(dev);
      if (band !== "Unknown") {
        bands[band].push(e.duration);
      }
    });

    return {
      Low: { stats: calculateBoxStats(bands.Low), raw: bands.Low },
      Medium: { stats: calculateBoxStats(bands.Medium), raw: bands.Medium },
      High: { stats: calculateBoxStats(bands.High), raw: bands.High },
    };
  }, [events]);

  // Compute Timeline Data
  const timelineData = useMemo(() => {
    if (events.length === 0) return { bins: [], formatType: "relative" as const };

    const parsedTimes = events.map((e) => {
      const baseDate = parseSessionDatetime(e.path);
      return {
        hasAbs: baseDate !== null,
        absoluteTimeMs: baseDate ? baseDate.getTime() + e.t_start * 1000 : null,
        relativeTimeMs: e.t_start * 1000,
        event: e,
      };
    });

    // Never mix epoch timestamps with relative clip offsets. A partially named
    // deployment would otherwise collapse every dated event into the last bin.
    const hasAbsoluteTimes = parsedTimes.every((et) => et.hasAbs);
    const eventTimes = parsedTimes.map((et) => ({
      ...et,
      timeMs: hasAbsoluteTimes ? et.absoluteTimeMs as number : et.relativeTimeMs,
    }));
    const times = eventTimes.map((et) => et.timeMs);
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const rangeMs = maxTime - minTime;

    // Dynamic Binning
    let binSizeMs = 60 * 1000; // 1 min default
    if (rangeMs > 12 * 3600 * 1000) {
      binSizeMs = 30 * 60 * 1000; // 30 min
    } else if (rangeMs > 4 * 3600 * 1000) {
      binSizeMs = 15 * 60 * 1000; // 15 min
    } else if (rangeMs > 3600 * 1000) {
      binSizeMs = 5 * 60 * 1000; // 5 min
    } else if (rangeMs > 600 * 1000) {
      binSizeMs = 2 * 60 * 1000; // 2 min
    }

    const binCount = Math.max(1, Math.min(100, Math.ceil(rangeMs / binSizeMs)));
    const bins = Array.from({ length: binCount }, (_, i) => {
      const start = minTime + i * binSizeMs;
      const end = start + binSizeMs;
      return {
        start,
        end,
        count: 0,
      };
    });

    eventTimes.forEach((et) => {
      let binIdx = Math.floor((et.timeMs - minTime) / binSizeMs);
      if (binIdx >= binCount) binIdx = binCount - 1;
      if (binIdx < 0) binIdx = 0;
      if (bins[binIdx]) {
        bins[binIdx].count++;
      }
    });

    return {
      bins,
      formatType: hasAbsoluteTimes ? ("absolute" as const) : ("relative" as const),
      minTime,
      binSizeMs,
    };
  }, [events]);

  // Compute Sortable Site Summaries
  const siteSummaries = useMemo(() => {
    const groups: Record<
      string,
      { site: string; count: number; durations: number[]; frequencies: number[] }
    > = {};

    events.forEach((e) => {
      const dev = findDeviceId(e.path);
      const siteName = dev || e.path.split("/").pop() || "Unknown";
      if (!groups[siteName]) {
        groups[siteName] = {
          site: siteName,
          count: 0,
          durations: [],
          frequencies: [],
        };
      }
      groups[siteName].count++;
      groups[siteName].durations.push(e.duration);
      groups[siteName].frequencies.push(e.center_freq);
    });

    const summaries = Object.values(groups).map((g) => {
      const meanDuration = g.durations.reduce((a, b) => a + b, 0) / g.durations.length;
      const medianFreq = getMedian(g.frequencies);
      return {
        site: g.site,
        count: g.count,
        meanDuration,
        medianFreq,
      };
    });

    // Sort
    summaries.sort((a, b) => {
      let valA: string | number = a[siteSortBy];
      let valB: string | number = b[siteSortBy];

      if (typeof valA === "string") {
        valA = (valA as string).toLowerCase();
        valB = (valB as string).toLowerCase();
      }

      if (valA < valB) return siteSortAsc ? -1 : 1;
      if (valA > valB) return siteSortAsc ? 1 : -1;
      return 0;
    });

    return summaries;
  }, [events, siteSortBy, siteSortAsc]);

  const handleSiteSort = (field: "site" | "count" | "meanDuration" | "medianFreq") => {
    if (siteSortBy === field) {
      setSiteSortAsc(!siteSortAsc);
    } else {
      setSiteSortBy(field);
      setSiteSortAsc(false);
    }
  };

  const showTooltip = (
    e: React.MouseEvent,
    title: string,
    content: string[]
  ) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const parentRect = e.currentTarget.parentElement?.getBoundingClientRect();
    const x = rect.left - (parentRect?.left ?? 0) + rect.width / 2;
    const y = rect.top - (parentRect?.top ?? 0) - 10;
    setTooltip({ x, y, title, content, show: true });
  };

  const hideTooltip = () => {
    setTooltip((prev) => ({ ...prev, show: false }));
  };

  return (
    <div className="sanity-checks">
      <div className="sanity-header">
        <h3 className="sanity-title">Diagnostic Sanity Checks</h3>
        <div className="sanity-tabs">
          <button
            className={`sanity-tab-btn ${activeTab === "elevation" ? "active" : ""}`}
            onClick={() => setActiveTab("elevation")}
          >
            Elevation vs. Duration
          </button>
          <button
            className={`sanity-tab-btn ${activeTab === "timeline" ? "active" : ""}`}
            onClick={() => setActiveTab("timeline")}
          >
            Bout Activity Timeline
          </button>
          <button
            className={`sanity-tab-btn ${activeTab === "sites" ? "active" : ""}`}
            onClick={() => setActiveTab("sites")}
          >
            Site Summaries
          </button>
        </div>
      </div>

      <div className="sanity-body">
        {events.length === 0 ? (
          <div className="empty-state">No events detected in this session.</div>
        ) : (
          <>
            {/* Tooltip Overlay */}
            {tooltip.show && (
              <div
                className="sanity-tooltip"
                style={{
                  left: tooltip.x,
                  top: tooltip.y,
                  transform: "translate(-50%, -100%)",
                }}
              >
                <div className="tooltip-title">{tooltip.title}</div>
                {tooltip.content.map((line, idx) => (
                  <div key={idx} className="tooltip-line">
                    {line}
                  </div>
                ))}
              </div>
            )}

            {/* TAB 1: Elevation vs Duration Box Plot */}
            {activeTab === "elevation" && (
              <div className="diagnostic-view elevation-view">
                <div className="view-desc">
                  Duration distributions across <b>Low (PSL)</b>, <b>Medium (PSM)</b>, and <b>High (PSH/H)</b> elevation bands. Hover boxes for statistics.
                </div>
                <div className="plot-container">
                  <ElevationPlot
                    data={elevationData}
                    onHover={showTooltip}
                    onLeave={hideTooltip}
                  />
                </div>
              </div>
            )}

            {/* TAB 2: Bout Activity Timeline */}
            {activeTab === "timeline" && (
              <div className="diagnostic-view timeline-view">
                <div className="view-desc">
                  Density of event occurrences over the course of the session. Hover bars to see detailed time periods and counts.
                </div>
                <div className="plot-container">
                  <TimelinePlot
                    data={timelineData}
                    onHover={showTooltip}
                    onLeave={hideTooltip}
                  />
                </div>
              </div>
            )}

            {/* TAB 3: Sortable Site Summaries */}
            {activeTab === "sites" && (
              <div className="diagnostic-view sites-view">
                <div className="view-desc">
                  Summary stats grouped by unique recorder/site found in recording paths. Click headers to sort.
                </div>
                <div className="tablewrap">
                  <table className="site-table">
                    <thead>
                      <tr>
                        <th onClick={() => handleSiteSort("site")} className="sortable">
                          Site/Recorder {siteSortBy === "site" && (siteSortAsc ? "▲" : "▼")}
                        </th>
                        <th onClick={() => handleSiteSort("count")} className="sortable text-right">
                          Events {siteSortBy === "count" && (siteSortAsc ? "▲" : "▼")}
                        </th>
                        <th onClick={() => handleSiteSort("meanDuration")} className="sortable text-right">
                          Mean Duration {siteSortBy === "meanDuration" && (siteSortAsc ? "▲" : "▼")}
                        </th>
                        <th onClick={() => handleSiteSort("medianFreq")} className="sortable text-right">
                          Median Freq {siteSortBy === "medianFreq" && (siteSortAsc ? "▲" : "▼")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {siteSummaries.map((s, idx) => (
                        <tr key={idx} className="trow-site">
                          <td className="font-semibold">{s.site}</td>
                          <td className="text-right mono">{s.count.toLocaleString()}</td>
                          <td className="text-right mono">{s.meanDuration.toFixed(3)}s</td>
                          <td className="text-right mono">{(s.medianFreq / 1000).toFixed(2)} kHz</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Elevation vs Duration Plot Component
function ElevationPlot({
  data,
  onHover,
  onLeave,
}: {
  data: ElevationData;
  onHover: (e: React.MouseEvent, title: string, content: string[]) => void;
  onLeave: () => void;
}) {
  const bands = ["Low", "Medium", "High"] as const;

  // Find max duration in events to set Y-axis scale (cap at 98th percentile to avoid stretch)
  const allRaw = [...data.Low.raw, ...data.Medium.raw, ...data.High.raw];
  const maxRaw = allRaw.length > 0 ? Math.max(...allRaw) : 5.0;
  // Dynamic max scale with a reasonable minimum of 1s
  const maxScale = Math.max(1.0, maxRaw);

  const width = 580;
  const height = 240;
  const padding = { top: 20, right: 30, bottom: 40, left: 60 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const yPos = (val: number) => {
    return padding.top + (1 - val / maxScale) * plotHeight;
  };

  const xPos = (idx: number) => {
    return padding.left + ((idx + 1) * plotWidth) / 4;
  };

  const colors = {
    Low: { stroke: "#b07ae0", fill: "rgba(176, 122, 224, 0.2)" },
    Medium: { stroke: "#e35b4a", fill: "rgba(227, 91, 74, 0.2)" },
    High: { stroke: "#f4a23a", fill: "rgba(244, 162, 58, 0.2)" },
  };

  return (
    <svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} className="sanity-svg">
      <defs>
        <linearGradient id="lowGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#b07ae0" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#5b2a86" stopOpacity="0.1" />
        </linearGradient>
        <linearGradient id="medGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e35b4a" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#a83279" stopOpacity="0.1" />
        </linearGradient>
        <linearGradient id="highGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f4a23a" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#ffe08a" stopOpacity="0.1" />
        </linearGradient>
      </defs>

      {/* Grid Lines */}
      {Array.from({ length: 5 }).map((_, i) => {
        const val = (maxScale * i) / 4;
        const y = yPos(val);
        return (
          <g key={i} className="grid-group">
            <line
              x1={padding.left}
              y1={y}
              x2={width - padding.right}
              y2={y}
              stroke="var(--line)"
              strokeDasharray="4 4"
            />
            <text
              x={padding.left - 10}
              y={y + 4}
              textAnchor="end"
              className="axis-label mono"
              fill="var(--text-faint)"
              fontSize="10"
            >
              {val.toFixed(2)}s
            </text>
          </g>
        );
      })}

      {/* Box Plots */}
      {bands.map((band, idx) => {
        const bandInfo = data[band];
        const stats = bandInfo.stats;
        const x = xPos(idx);
        const colWidth = 50;

        if (!stats) {
          return (
            <g key={band} transform={`translate(${x}, ${height / 2})`}>
              <text textAnchor="middle" className="axis-label" fill="var(--text-faint)">
                No data
              </text>
            </g>
          );
        }

        const yMax = yPos(stats.max);
        const yQ3 = yPos(stats.q3);
        const yMed = yPos(stats.median);
        const yQ1 = yPos(stats.q1);
        const yMin = yPos(stats.min);
        const yMean = yPos(stats.mean);

        const gradMap = { Low: "url(#lowGrad)", Medium: "url(#medGrad)", High: "url(#highGrad)" };

        // Generate deterministic jitter for raw data points to overlay
        const rawPoints = bandInfo.raw;
        // Cap visual points to 150 per band for performance
        const samplePoints = rawPoints.length > 150 
          ? rawPoints.filter((_: number, index: number) => index % Math.ceil(rawPoints.length / 150) === 0)
          : rawPoints;

        return (
          <g key={band} className="boxplot-group">
            {/* Whiskers */}
            <line x1={x} y1={yMin} x2={x} y2={yMax} stroke={colors[band].stroke} strokeWidth="1.5" />
            <line x1={x - 12} y1={yMax} x2={x + 12} y2={yMax} stroke={colors[band].stroke} strokeWidth="1.5" />
            <line x1={x - 12} y1={yMin} x2={x + 12} y2={yMin} stroke={colors[band].stroke} strokeWidth="1.5" />

            {/* Jittered points overlay */}
            {samplePoints.map((dur: number, pIdx: number) => {
              const pY = yPos(dur);
              const jitterX = x + ((pIdx * 37) % 24) - 12; // deterministic jitter
              return (
                <circle
                  key={pIdx}
                  cx={jitterX}
                  cy={pY}
                  r="2.5"
                  fill={colors[band].stroke}
                  opacity="0.25"
                  style={{ pointerEvents: "none" }}
                />
              );
            })}

            {/* Box Rect */}
            <rect
              x={x - colWidth / 2}
              y={yQ3}
              width={colWidth}
              height={Math.max(2, yQ1 - yQ3)}
              fill={gradMap[band]}
              stroke={colors[band].stroke}
              strokeWidth="2"
              className="boxplot-box"
              style={{ cursor: "pointer" }}
              onMouseEnter={(e) =>
                onHover(e, `${band} Elevation Band`, [
                  `Total events: ${stats.count}`,
                  `Max duration: ${stats.max.toFixed(3)}s`,
                  `75% (Q3): ${stats.q3.toFixed(3)}s`,
                  `Median: ${stats.median.toFixed(3)}s`,
                  `Mean: ${stats.mean.toFixed(3)}s`,
                  `25% (Q1): ${stats.q1.toFixed(3)}s`,
                  `Min duration: ${stats.min.toFixed(3)}s`,
                ])
              }
              onMouseLeave={onLeave}
            />

            {/* Median Line */}
            <line
              x1={x - colWidth / 2}
              y1={yMed}
              x2={x + colWidth / 2}
              y2={yMed}
              stroke="var(--text)"
              strokeWidth="2.5"
              style={{ pointerEvents: "none" }}
            />

            {/* Mean Diamond */}
            <path
              d={`M ${x} ${yMean - 4} L ${x + 4} ${yMean} L ${x} ${yMean + 4} L ${x - 4} ${yMean} Z`}
              fill="#fff"
              stroke={colors[band].stroke}
              strokeWidth="1"
              style={{ pointerEvents: "none" }}
            />

            {/* Column Label */}
            <text
              x={x}
              y={height - padding.bottom + 22}
              textAnchor="middle"
              className="axis-label font-semibold"
              fill="var(--text)"
              fontSize="12"
            >
              {band}
            </text>
            <text
              x={x}
              y={height - padding.bottom + 34}
              textAnchor="middle"
              className="axis-label mono"
              fill="var(--text-faint)"
              fontSize="10"
            >
              n={stats.count}
            </text>
          </g>
        );
      })}

      <line
        x1={padding.left}
        y1={height - padding.bottom}
        x2={width - padding.right}
        y2={height - padding.bottom}
        stroke="var(--line-2)"
      />
    </svg>
  );
}

// Timeline Activity Plot Component
function TimelinePlot({
  data,
  onHover,
  onLeave,
}: {
  data: TimelineData;
  onHover: (e: React.MouseEvent, title: string, content: string[]) => void;
  onLeave: () => void;
}) {
  const { bins, formatType, minTime = 0 } = data;

  const width = 580;
  const height = 200;
  const padding = { top: 20, right: 30, bottom: 40, left: 50 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const maxCount = bins.length > 0 ? Math.max(...bins.map((b) => b.count)) : 0;
  const maxScale = Math.max(1, maxCount);

  const getBarHeight = (count: number) => {
    return (count / maxScale) * plotHeight;
  };

  const getBarX = (idx: number) => {
    return padding.left + (idx * plotWidth) / bins.length;
  };

  const barWidth = Math.max(1, (plotWidth / bins.length) - 2);

  const formatTimeLabel = (timeMs: number) => {
    if (formatType === "absolute") {
      const d = new Date(timeMs);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } else {
      const mins = Math.floor(timeMs / 60000);
      return `+${mins}m`;
    }
  };

  return (
    <svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} className="sanity-svg">
      <defs>
        <linearGradient id="timelineGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--amber)" />
          <stop offset="50%" stopColor="var(--coral)" />
          <stop offset="100%" stopColor="var(--spec-2)" stopOpacity="0.4" />
        </linearGradient>
      </defs>

      {/* Grid Lines */}
      {Array.from({ length: 4 }).map((_, i) => {
        const val = Math.round((maxScale * i) / 3);
        const y = padding.top + (1 - val / maxScale) * plotHeight;
        return (
          <g key={i} className="grid-group">
            <line
              x1={padding.left}
              y1={y}
              x2={width - padding.right}
              y2={y}
              stroke="var(--line)"
              strokeDasharray="4 4"
            />
            <text
              x={padding.left - 10}
              y={y + 4}
              textAnchor="end"
              className="axis-label mono"
              fill="var(--text-faint)"
              fontSize="10"
            >
              {val}
            </text>
          </g>
        );
      })}

      {/* Histogram Bars */}
      {bins.map((bin, idx) => {
        const x = getBarX(idx);
        const barH = getBarHeight(bin.count);
        const y = height - padding.bottom - barH;

        const timeStartStr = formatTimeLabel(bin.start - (formatType === "absolute" ? 0 : minTime));
        const timeEndStr = formatTimeLabel(bin.end - (formatType === "absolute" ? 0 : minTime));

        return (
          <rect
            key={idx}
            x={x}
            y={y}
            width={barWidth}
            height={Math.max(1, barH)}
            fill="url(#timelineGrad)"
            rx="2"
            ry="2"
            className="timeline-bar"
            style={{ transition: "all 0.2s", cursor: "pointer" }}
            onMouseEnter={(e) =>
              onHover(e, `Timeline Bin #${idx + 1}`, [
                `Time span: ${timeStartStr} - ${timeEndStr}`,
                `Event count: ${bin.count}`,
              ])
            }
            onMouseLeave={onLeave}
          />
        );
      })}

      {/* Bottom Axis Line */}
      <line
        x1={padding.left}
        y1={height - padding.bottom}
        x2={width - padding.right}
        y2={height - padding.bottom}
        stroke="var(--line-2)"
      />

      {/* Axis Labels (X) */}
      {bins.length > 0 && (
        <>
          {/* Start label */}
          <text
            x={padding.left}
            y={height - padding.bottom + 18}
            textAnchor="start"
            className="axis-label mono"
            fill="var(--text-dim)"
            fontSize="10.5"
          >
            {formatTimeLabel(formatType === "absolute" ? bins[0].start : 0)}
          </text>

          {/* Middle label */}
          {bins.length > 2 && (
            <text
              x={padding.left + plotWidth / 2}
              y={height - padding.bottom + 18}
              textAnchor="middle"
              className="axis-label mono"
              fill="var(--text-dim)"
              fontSize="10.5"
            >
              {formatTimeLabel(
                formatType === "absolute"
                  ? bins[Math.floor(bins.length / 2)].start
                  : bins[Math.floor(bins.length / 2)].start - minTime
              )}
            </text>
          )}

          {/* End label */}
          <text
            x={width - padding.right}
            y={height - padding.bottom + 18}
            textAnchor="end"
            className="axis-label mono"
            fill="var(--text-dim)"
            fontSize="10.5"
          >
            {formatTimeLabel(
              formatType === "absolute" ? bins[bins.length - 1].end : bins[bins.length - 1].end - minTime
            )}
          </text>
        </>
      )}
    </svg>
  );
}
