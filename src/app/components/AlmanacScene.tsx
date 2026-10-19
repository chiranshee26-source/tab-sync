/**
 * The home-page illustration: an autumn landscape drawn for the actual time
 * of day. The sun (or moon) travels along an arc, and the sky and hills
 * change colour from dawn to night. Flat layered shapes with a print-like
 * grain, in the spirit of a risograph poster.
 */

import { phaseAt, skyProgress, type Phase, type SunTimes } from '../sun';

export type { Phase };

interface PhaseColours {
  sky: [string, string, string];
  body: string;
  glow: string;
  hills: [string, string, string, string];
  trees: [string, string, string];
}

const COLOURS: Record<Phase, PhaseColours> = {
  dawn: {
    sky: ['#b9a7b8', '#eab8a0', '#f7dcc0'],
    body: '#fff1dc',
    glow: '#ffd9b0',
    hills: ['#c9a493', '#b9805f', '#8a6a3f', '#4a3528'],
    trees: ['#b4532a', '#c98b2b', '#8f3b24'],
  },
  day: {
    sky: ['#a9c3c9', '#cfdcd6', '#f1e6cf'],
    body: '#fffaf0',
    glow: '#fff2d6',
    hills: ['#c7b39a', '#c98f4f', '#7c7a37', '#4a3626'],
    trees: ['#b8501f', '#dc9a2e', '#9b3a1f'],
  },
  golden: {
    sky: ['#e7a46a', '#efbf84', '#f6dcaa'],
    body: '#fff0c9',
    glow: '#ffc979',
    hills: ['#c98e6a', '#b3693a', '#74652f', '#3f2c20'],
    trees: ['#a6441f', '#c98126', '#7f3018'],
  },
  dusk: {
    sky: ['#4c3446', '#8a5357', '#d98b67'],
    body: '#ffd6a8',
    glow: '#f3a172',
    hills: ['#6d4b52', '#6a3f36', '#47402a', '#26191a'],
    trees: ['#7a3322', '#8f5a22', '#5c2416'],
  },
  night: {
    sky: ['#16121d', '#251d2c', '#3a2c38'],
    body: '#f3e7cf',
    glow: '#8f7aa0',
    hills: ['#3a2f3a', '#2e2529', '#25211c', '#151012'],
    trees: ['#4a2a22', '#55401f', '#3a1d17'],
  },
};

/** Position on the sky arc, following the real sunrise and sunset. */
function celestialPosition(now: Date, sun: SunTimes | null): { x: number; y: number; isSun: boolean } {
  const { t, isSun } = skyProgress(now, sun);
  return { x: 110 + t * 980, y: 440 - Math.sin(Math.PI * t) * 330, isSun };
}

// Deterministic "random" star field.
const STARS = Array.from({ length: 46 }, (_, i) => ({
  x: (i * 263) % 1200,
  y: (i * 131) % 260,
  r: 0.6 + ((i * 7) % 5) * 0.25,
  o: 0.35 + ((i * 11) % 6) * 0.1,
}));

/** Rounded autumn tree: trunk plus two overlapping crowns. */
function Tree({ x, y, size, colour, trunk }: { x: number; y: number; size: number; colour: string; trunk: string }) {
  return (
    <g>
      <rect x={x - size * 0.07} y={y - size * 0.2} width={size * 0.14} height={size * 0.75} rx={size * 0.05} fill={trunk} />
      <ellipse cx={x} cy={y - size * 0.55} rx={size * 0.5} ry={size * 0.6} fill={colour} />
      <ellipse cx={x + size * 0.2} cy={y - size * 0.75} rx={size * 0.3} ry={size * 0.36} fill={colour} opacity="0.7" />
    </g>
  );
}

export function AlmanacScene({ now, sun }: { now: Date; sun: SunTimes | null }) {
  const phase = phaseAt(now, sun);
  const c = COLOURS[phase];
  const { x, y, isSun } = celestialPosition(now, sun);
  const trunk = c.hills[3];

  return (
    <svg className="almanac" viewBox="0 0 1200 520" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={c.sky[0]} />
          <stop offset="0.55" stopColor={c.sky[1]} />
          <stop offset="1" stopColor={c.sky[2]} />
        </linearGradient>
        <radialGradient id="glow">
          <stop offset="0" stopColor={c.glow} stopOpacity="0.85" />
          <stop offset="1" stopColor={c.glow} stopOpacity="0" />
        </radialGradient>
        <filter id="grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix values="0 0 0 0 0.15  0 0 0 0 0.1  0 0 0 0 0.05  0 0 0 0.55 0" />
        </filter>
      </defs>

      <rect width="1200" height="520" fill="url(#sky)" />
      {phase === 'night' &&
        STARS.map((s, i) => <circle key={i} className="star" cx={s.x} cy={s.y} r={s.r} fill="#f6ead2" opacity={s.o} />)}

      <circle cx={x} cy={y} r="150" fill="url(#glow)" />
      {isSun ? (
        <circle cx={x} cy={y} r="46" fill={c.body} />
      ) : (
        // Crescent: the moon disc minus an offset disc, cut out with a mask.
        <>
          <mask id="crescent">
            <circle cx={x} cy={y} r="34" fill="white" />
            <circle cx={x + 15} cy={y - 9} r="30" fill="black" />
          </mask>
          <circle cx={x} cy={y} r="34" fill={c.body} mask="url(#crescent)" />
        </>
      )}

      <path
        d="M0 300 C150 250 300 270 450 285 S750 228 900 258 S1120 282 1200 248 L1200 520 L0 520Z"
        fill={c.hills[0]}
      />
      <path
        d="M0 362 C120 332 260 320 400 345 S640 392 800 352 S1080 300 1200 330 L1200 520 L0 520Z"
        fill={c.hills[1]}
      />
      <Tree x={760} y={360} size={56} colour={c.trees[1]} trunk={trunk} />
      <Tree x={815} y={356} size={42} colour={c.trees[2]} trunk={trunk} />
      <Tree x={890} y={345} size={64} colour={c.trees[2]} trunk={trunk} />
      <Tree x={960} y={338} size={86} colour={c.trees[0]} trunk={trunk} />
      <Tree x={1030} y={334} size={48} colour={c.trees[1]} trunk={trunk} />
      <path
        d="M0 422 C160 392 330 402 480 422 S760 452 900 426 S1100 396 1200 412 L1200 520 L0 520Z"
        fill={c.hills[2]}
      />
      <Tree x={1110} y={418} size={62} colour={c.trees[1]} trunk={trunk} />
      <Tree x={1165} y={424} size={44} colour={c.trees[0]} trunk={trunk} />
      <path d="M0 472 C200 456 420 470 600 478 S1000 460 1200 470 L1200 520 L0 520Z" fill={c.hills[3]} />

      <rect width="1200" height="520" filter="url(#grain)" opacity="0.28" style={{ mixBlendMode: 'multiply' }} />
    </svg>
  );
}

const LEAF_PATH = 'M12 2C7 6 4 10 4 14a8 8 0 0 0 16 0c0-4-3-8-8-12Zm0 4v14';
const LEAVES = [
  { left: 8, delay: 0, duration: 14, size: 18, colour: '#b4532a' },
  { left: 22, delay: 5, duration: 17, size: 14, colour: '#c98b2b' },
  { left: 37, delay: 9, duration: 15, size: 20, colour: '#8f3b24' },
  { left: 55, delay: 2, duration: 18, size: 15, colour: '#d39a35' },
  { left: 68, delay: 11, duration: 16, size: 19, colour: '#b4532a' },
  { left: 81, delay: 6, duration: 13, size: 13, colour: '#c98b2b' },
  { left: 93, delay: 13, duration: 19, size: 17, colour: '#99412a' },
];

/** A few leaves drifting across the hero (disabled with reduced motion). */
export function FallingLeaves() {
  return (
    <div className="leaves" aria-hidden="true">
      {LEAVES.map((leaf, i) => (
        <span
          key={i}
          className="leaf"
          style={
            {
              '--left': `${leaf.left}%`,
              '--delay': `${-leaf.delay}s`,
              '--duration': `${leaf.duration}s`,
              '--size': `${leaf.size}px`,
              color: leaf.colour,
            } as React.CSSProperties
          }
        >
          <svg viewBox="0 0 24 24">
            <path d={LEAF_PATH} fill="currentColor" stroke="rgb(0 0 0 / 0.25)" strokeWidth="1" />
          </svg>
        </span>
      ))}
    </div>
  );
}
