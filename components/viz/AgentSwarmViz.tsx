'use client';

// ---------------------------------------------------------------------
// THIS IS AN ILLUSTRATION, AND IT SAYS SO ON ITS FACE.
//
// The reference's `swarmSVG()` draws four layers (8/18/18/10 nodes) with randomly
// activated edges, implying ~300 sub-agents scanning in parallel. No such thing
// exists in this backend, and the brief pre-authorises exactly this resolution:
//
//   "if the backend exposes per-sub-agent or per-strategy-candidate activity,
//    bind node/edge activity to that. If it doesn't, keep the visualization but
//    label it clearly as an illustrative representation of the single agent's
//    multi-model ensemble ... not a fabricated multi-agent swarm."
//
// So the layers are bound to REAL structure rather than to a made-up count:
//
//   layer 0  the symbols actually being watched
//   layer 1  the specialist panel (9 with Polymarket on, 7 without)
//   layer 2  the strategy candidates that were scored
//   layer 3  the single decision
//
// Edge activity is driven by the live `currentNode`, not `Math.random()`.
//
// TWO THINGS THE REFERENCE DOES THAT ARE FIXED HERE
//
// 1. `Math.random()` in the render path re-randomises the whole graph on every
//    re-render, so the picture twitches on any unrelated state change. Geometry
//    here is derived from a deterministic hash of the layer/index, so it is stable
//    across renders and identical between server and client — a random layout
//    would also produce a hydration mismatch.
//
// 2. The hardcoded palette (`#22D3EE`, `#A855F7`, `#EC4899`) ignores the themes.
//    These use the design tokens, so Platinum does not get neon pink.
// ---------------------------------------------------------------------

import { useMemo } from 'react';

export type SwarmLayer = {
  label: string;
  /** How many nodes to draw. Real counts, not a decorative number. */
  count: number;
  color: string;
  /** Set when this layer is the one currently doing work. */
  active?: boolean;
};

/** Deterministic pseudo-random in [0,1) from two small integers.
 *
 *  Replaces `Math.random()` so the layout is stable across renders and matches
 *  between server and client. Any cheap integer hash works; this one is a
 *  standard sine-fract mix. */
function hash(a: number, b: number): number {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export function AgentSwarmViz({
  layers,
  height = 220,
  note,
}: {
  layers: SwarmLayer[];
  height?: number;
  /** Extra caption. The illustrative disclaimer is always rendered regardless. */
  note?: string;
}) {
  const width = 760;

  const geometry = useMemo(() => {
    const xs = layers.map((_, i) =>
      layers.length === 1 ? width / 2 : 30 + (i * (width - 60)) / (layers.length - 1),
    );

    const positions = layers.map((layer, li) => {
      const pad = 26;
      const n = Math.max(1, layer.count);
      return Array.from({ length: n }, (_, i) => ({
        x: xs[li],
        y: n === 1 ? height / 2 : pad + ((height - 2 * pad) * i) / (n - 1),
      }));
    });

    const edges: { d: string; active: boolean; color: string }[] = [];
    for (let li = 0; li < positions.length - 1; li += 1) {
      const from = positions[li];
      const to = positions[li + 1];
      const nextActive = layers[li + 1]?.active === true;

      from.forEach((p, i) => {
        // Two or three edges per node, chosen deterministically.
        const fanout = 2 + Math.floor(hash(li * 31 + i, 7) * 2);
        for (let k = 0; k < fanout; k += 1) {
          const t = to[Math.floor(hash(li * 71 + i * 13 + k, 3) * to.length)];
          if (!t) continue;
          const mx = (p.x + t.x) / 2;
          edges.push({
            d: `M${p.x},${p.y} C ${mx},${p.y} ${mx},${t.y} ${t.x},${t.y}`,
            // Active because the NEXT layer is the one working, not at random.
            active: nextActive,
            color: layers[li + 1]?.color ?? 'var(--text-muted)',
          });
        }
      });
    }

    return { positions, edges, xs };
  }, [layers, height, width]);

  const total = layers.reduce((n, l) => n + l.count, 0);

  return (
    <div>
      <div className="swarm-box" style={{ height }}>
        <svg
          width="100%"
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          aria-label="Agent ensemble structure"
        >
          {geometry.edges.map((e, i) => (
            <path
              key={i}
              d={e.d}
              fill="none"
              stroke={e.active ? e.color : 'var(--text-muted)'}
              strokeWidth={e.active ? 1.1 : 0.5}
              opacity={e.active ? 0.5 : 0.1}
            />
          ))}
          {geometry.positions.map((layer, li) =>
            layer.map((p, i) => (
              <circle
                key={`${li}-${i}`}
                cx={p.x}
                cy={p.y}
                r={li === 0 || li === geometry.positions.length - 1 ? 3.2 : 2.4}
                fill={layers[li].color}
                opacity={layers[li].active ? 0.95 : 0.55}
              />
            )),
          )}
        </svg>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2">
        {layers.map((l) => (
          <span key={l.label} className="flex items-center gap-1.5 text-[10.5px]">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: l.color }} aria-hidden />
            <span style={{ color: 'var(--text-secondary)' }}>{l.label}</span>
            <span className="mono" style={{ color: 'var(--text-muted)' }}>
              {l.count}
            </span>
          </span>
        ))}
      </div>

      {/* Always rendered. This is the label the brief requires, and it must not be
          possible to read the picture as a live swarm of 300 agents. */}
      <div className="text-[10.5px] mt-2 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        <span
          className="font-mono text-[9.5px] uppercase tracking-wider mr-1.5 px-1 py-0.5 rounded"
          style={{
            background: 'color-mix(in srgb, var(--warning) 14%, transparent)',
            color: 'var(--warning)',
          }}
        >
          Illustrative
        </span>
        Structure of the single agent&apos;s ensemble — {total} real nodes across{' '}
        {layers.length} stages. This is <strong>not</strong> a multi-agent swarm: there are no
        sub-agents behind these dots. Node counts and edge activity come from the live
        panel and the current graph node; the layout is decorative.
        {note ? ` ${note}` : ''}
      </div>
    </div>
  );
}
