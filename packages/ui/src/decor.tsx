/*
 * Decoration only: every element here is aria-hidden, ignores the pointer and is a static SVG, so it
 * costs nothing while scrolling. Colours come from `currentColor` and the theme, so dark mode follows.
 */

const W = 320;
const H = 160;
const LINES = 12;

/** Height of contour line `n` at `x`: a rising swell, each line a little flatter than the one above it. */
const contourY = (n: number, x: number): number => {
  const t = x / W;
  const spread = n / LINES;
  return H * (0.62 - 0.42 * t * t + spread * 0.34 * (1 - t * 0.6)) + Math.sin(t * 6.2 + 0.8 + spread * 1.5) * (14 - spread * 5);
};

const CONTOURS = Array.from({ length: LINES }, (_, n) =>
  Array.from({ length: 33 }, (_, i) => `${i ? 'L' : 'M'}${i * 10} ${contourY(n, i * 10).toFixed(1)}`).join(''),
);
const DOTS = [[2, 190], [0, 232], [5, 262]] as const;

/** Fine lines like a contour map (sidebar, phone header); set the colour with a text utility. */
export function ContourLines({ className = '', dots = true }: { className?: string; dots?: boolean }) {
  return (
    <svg aria-hidden viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" fill="none" stroke="currentColor" className={`pointer-events-none ${className}`}>
      {CONTOURS.map((d, n) => (
        <path key={d} d={d} vectorEffect="non-scaling-stroke" strokeWidth={n ? 0.8 : 1.4} strokeOpacity={n ? 0.5 - n * 0.033 : 0.9} />
      ))}
      {dots && DOTS.map(([n, x]) => (
        // A zero-length round-capped line: stays a circle however the drawing is stretched.
        <path key={x} d={`M${x} ${contourY(n, x)}h0`} vectorEffect="non-scaling-stroke" strokeWidth={5} strokeLinecap="round" />
      ))}
    </svg>
  );
}

/** The page's paper: a light wash, two soft swells at opposite corners, and a dot grid. Fills its positioned parent. */
export function PageBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden bg-page text-clip">
      <svg viewBox="0 0 400 300" preserveAspectRatio="none" fill="currentColor" className="absolute top-0 right-0 h-[55%] w-[38%] max-sm:w-[70%]">
        <path d="M400 0V250C372 190 330 178 290 130C252 84 262 30 190 0Z" opacity="0.07" />
        <path d="M400 0V150C376 112 350 106 326 70C308 42 312 18 284 0Z" opacity="0.09" />
      </svg>
      <svg viewBox="0 0 400 300" preserveAspectRatio="none" fill="currentColor" className="absolute bottom-0 left-0 h-[38%] w-[34%] max-sm:w-[70%]">
        <path d="M0 300V60C40 110 96 108 140 160C182 210 190 264 270 300Z" opacity="0.07" />
        <path d="M0 300V170C34 196 62 196 92 230C114 256 122 282 160 300Z" opacity="0.08" />
      </svg>
      <div className="absolute top-8 right-10 h-24 w-24 bg-[radial-gradient(currentColor_1.5px,transparent_1.5px)] bg-size-[24px_24px] opacity-35 max-lg:hidden" />
    </div>
  );
}

/** A small line of `values`, oldest first; a flat line when they are all zero. */
export function Sparkline({ values, className = '' }: { values: readonly number[]; className?: string }) {
  const max = Math.max(1, ...values);
  const step = 100 / Math.max(1, values.length - 1);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(2)} ${(22 - (v / max) * 20).toFixed(2)}`).join('');
  return (
    <svg aria-hidden viewBox="0 0 100 24" preserveAspectRatio="none" fill="none" stroke="currentColor" className={className}>
      <path d={`${d}V24H0Z`} fill="currentColor" stroke="none" opacity="0.16" />
      <path d={d} vectorEffect="non-scaling-stroke" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
