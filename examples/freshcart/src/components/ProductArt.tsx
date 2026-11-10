import type { ProductArt as Art } from "@/lib/db/schema";

const CREAM = "#F7F2E8";
const INK = "#1F2A24";

/** Flat, generated product illustration. No photos, no real packaging. */
export function ProductArt({
  art,
  label,
  className = "",
  title,
}: {
  art: Art;
  label: string;
  className?: string;
  title?: string;
}) {
  const initial = label.trim().charAt(0).toUpperCase();
  return (
    <div
      className={`relative aspect-square w-full overflow-hidden ${className}`}
      style={{ background: `color-mix(in oklab, ${art.color} 16%, #F4EFE5)` }}
    >
      <svg viewBox="0 0 200 200" className="h-full w-full" role="img" aria-label={title ?? label}>
        <ellipse cx="100" cy="171" rx="50" ry="6" fill={INK} opacity="0.08" />
        <Shape art={art} initial={initial} />
      </svg>
    </div>
  );
}

function Band({ x, y, w, h, fill, initial, textFill }: { x: number; y: number; w: number; h: number; fill: string; initial: string; textFill: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill={fill} />
      <text
        x={x + w / 2}
        y={y + h / 2 + 6}
        fill={textFill}
        fontSize="17"
        fontFamily="var(--font-serif), Georgia, serif"
        fontWeight="600"
        textAnchor="middle"
      >
        {initial}
      </text>
    </g>
  );
}

function Shape({ art, initial }: { art: Art; initial: string }) {
  const { color, accent } = art;
  const shade = { fill: INK, opacity: 0.12 };
  const shine = { fill: "#fff", opacity: 0.22 };
  switch (art.shape) {
    case "fruit":
      return (
        <g>
          <circle cx="100" cy="114" r="50" fill={color} />
          <path d="M100 164a50 50 0 0 0 50-50c-10 26-30 40-50 40s-36-8-46-22a50 50 0 0 0 46 32z" {...shade} />
          <ellipse cx="80" cy="96" rx="10" ry="15" transform="rotate(-25 80 96)" {...shine} />
          <path d="M100 66c0-8 2-14 6-18" stroke="#5C4632" strokeWidth="4" strokeLinecap="round" fill="none" />
          <path d="M106 56c10-10 24-10 30-4-8 10-20 12-30 4z" fill={accent} />
        </g>
      );
    case "greens":
      return (
        <g>
          {[-34, 0, 34].map((deg, i) => (
            <g key={deg} transform={`rotate(${deg} 100 160)`}>
              <path
                d="M100 160C62 132 64 82 100 50c36 32 38 82 0 110z"
                fill={i === 1 ? color : accent}
              />
              <path d="M100 156V62" stroke={CREAM} strokeOpacity="0.45" strokeWidth="2.5" />
              <path d="M100 120l-16-14M100 100l14-12M100 136l14-12" stroke={CREAM} strokeOpacity="0.35" strokeWidth="2" />
            </g>
          ))}
        </g>
      );
    case "root":
      return (
        <g>
          {[-20, 0, 20].map((deg) => (
            <g key={deg} transform={`rotate(${deg} 100 165)`}>
              <path d="M90 66c-6 6 0 18 2 22M100 64v-14M110 66c6 6 0 18-2 22" stroke={accent} strokeWidth="5" strokeLinecap="round" fill="none" />
              <path d="M86 74q14-6 28 0l-12 90q-2 6-4 0z" fill={color} />
              <path d="M92 96h8M95 118h7M97 140h5" stroke={INK} strokeOpacity="0.15" strokeWidth="2" strokeLinecap="round" />
            </g>
          ))}
        </g>
      );
    case "carton":
      return (
        <g>
          <rect x="94" y="38" width="12" height="10" fill={accent} />
          <path d="M68 70l32-24 32 24z" fill={color} />
          <path d="M100 46l32 24h-32z" {...shade} />
          <rect x="68" y="70" width="64" height="96" fill={color} />
          <rect x="68" y="70" width="64" height="96" fill="none" stroke={INK} strokeOpacity="0.08" />
          <Band x={68} y={100} w={64} h={34} fill={accent} initial={initial} textFill={CREAM} />
        </g>
      );
    case "bottle":
      return (
        <g>
          <rect x="91" y="36" width="18" height="14" rx="2" fill={accent} />
          <rect x="93" y="50" width="14" height="16" fill={color} />
          <path d="M78 88q0-18 15-22h14q15 4 15 22v72q0 8-8 8H86q-8 0-8-8z" fill={color} />
          <rect x="112" y="92" width="6" height="64" rx="3" {...shine} />
          <Band x={78} y={106} w={44} h={36} fill={accent} initial={initial} textFill={color} />
        </g>
      );
    case "jar":
      return (
        <g>
          <rect x="70" y="60" width="60" height="18" rx="4" fill={accent} />
          <path d="M70 66h60" stroke={INK} strokeOpacity="0.15" strokeWidth="2" />
          <rect x="66" y="76" width="68" height="90" rx="14" fill={color} />
          <rect x="116" y="88" width="7" height="60" rx="3.5" {...shine} />
          <Band x={66} y={102} w={68} h={36} fill={CREAM} initial={initial} textFill={color} />
        </g>
      );
    case "bag":
      return (
        <g>
          <path d="M64 64h72l6 100q-42 8-84 0z" fill={color} />
          <rect x="62" y="54" width="76" height="14" rx="2" fill={accent} />
          <path d="M70 58h60" stroke={INK} strokeOpacity="0.2" strokeWidth="2" strokeDasharray="3 3" />
          <path d="M128 72l6 88" stroke="#fff" strokeOpacity="0.2" strokeWidth="5" strokeLinecap="round" />
          <circle cx="100" cy="116" r="22" fill={accent} />
          <text x="100" y="122" fill={color} fontSize="17" fontWeight="600" fontFamily="var(--font-serif), Georgia, serif" textAnchor="middle">
            {initial}
          </text>
        </g>
      );
    case "box":
      return (
        <g>
          <path d="M62 60l16-12h72l-16 12z" fill={color} />
          <path d="M62 60l16-12h72l-16 12z" {...shine} />
          <path d="M134 60l16-12v104l-16 12z" fill={color} />
          <path d="M134 60l16-12v104l-16 12z" {...shade} />
          <rect x="62" y="60" width="72" height="104" fill={color} />
          <Band x={62} y={96} w={72} h={34} fill={accent} initial={initial} textFill={color} />
        </g>
      );
    case "loaf":
      return (
        <g>
          <path d="M48 142q0-62 52-62t52 62q0 10-10 10H58q-10 0-10-10z" fill={color} />
          <path d="M48 142q0 10 10 10h84q10 0 10-10q-20 6-52 6t-52-6z" {...shade} />
          {[74, 100, 126].map((x) => (
            <path key={x} d={`M${x - 10} ${108}q10-14 20-12`} stroke={accent} strokeWidth="5" strokeLinecap="round" fill="none" />
          ))}
          <path d="M66 98q10-12 24-14" stroke="#fff" strokeOpacity="0.25" strokeWidth="5" strokeLinecap="round" fill="none" />
        </g>
      );
    case "can":
      return (
        <g>
          <rect x="72" y="56" width="56" height="110" rx="6" fill={color} />
          <ellipse cx="100" cy="58" rx="28" ry="6" fill={color} />
          <ellipse cx="100" cy="58" rx="28" ry="6" {...shine} />
          <path d="M72 70h56M72 152h56" stroke={INK} strokeOpacity="0.15" strokeWidth="2" />
          <rect x="114" y="74" width="6" height="74" rx="3" {...shine} />
          <Band x={72} y={96} w={56} h={34} fill={accent} initial={initial} textFill={color} />
        </g>
      );
    case "tub":
      return (
        <g>
          <rect x="60" y="76" width="80" height="14" rx="4" fill={accent} />
          <path d="M64 90h72l-8 70q-28 6-56 0z" fill={color} />
          <path d="M64 90h72l-1 8H65z" {...shade} />
          <Band x={70} y={108} w={60} h={32} fill={accent} initial={initial} textFill={CREAM} />
        </g>
      );
    case "pump":
      return (
        <g>
          <rect x="86" y="50" width="26" height="12" rx="3" fill={accent} />
          <rect x="110" y="52" width="22" height="7" rx="3" fill={accent} />
          <rect x="94" y="62" width="12" height="20" fill={accent} />
          <rect x="74" y="82" width="52" height="84" rx="12" fill={color} />
          <rect x="112" y="92" width="6" height="62" rx="3" {...shine} />
          <Band x={74} y={106} w={52} h={34} fill={accent} initial={initial} textFill={color} />
        </g>
      );
    case "roll":
      return (
        <g>
          {[66, 100, 134].map((x) => (
            <g key={x}>
              <rect x={x - 17} y="72" width="34" height="92" fill={color} stroke={INK} strokeOpacity="0.08" />
              <path d={`M${x - 17} 120h34`} stroke={accent} strokeWidth="6" />
              <ellipse cx={x} cy="72" rx="17" ry="6" fill="#fff" />
              <ellipse cx={x} cy="72" rx="6" ry="2.5" fill={accent} />
            </g>
          ))}
        </g>
      );
    case "eggs":
      return (
        <g>
          {[66, 100, 134].map((x) => (
            <g key={x}>
              <ellipse cx={x} cy="110" rx="16" ry="21" fill={color} />
              <ellipse cx={x - 5} cy="102" rx="4" ry="7" {...shine} />
            </g>
          ))}
          <path d="M46 118h108l-6 42q-48 6-96 0z" fill={accent} />
          {[66, 100, 134].map((x) => (
            <path key={x} d={`M${x - 14} 118q14 14 28 0`} fill="none" stroke={INK} strokeOpacity="0.15" strokeWidth="2" />
          ))}
        </g>
      );
    case "wedge":
      return (
        <g>
          <path d="M50 124l96-36 8 10-96 36z" fill={color} />
          <path d="M50 124l96-36 8 10-96 36z" {...shine} />
          <path d="M58 134l96-36v58H58z" fill={color} />
          <path d="M50 124l8 10v22h-8z" fill={accent} />
          {[
            [82, 140, 6],
            [112, 128, 8],
            [134, 142, 5],
            [100, 150, 4],
          ].map(([cx, cy, r]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} fill={accent} opacity="0.7" />
          ))}
        </g>
      );
    case "bar":
      return (
        <g transform="rotate(-8 100 112)">
          <rect x="62" y="56" width="76" height="112" rx="4" fill={color} />
          <path d="M62 56h76v22H62z" fill={accent} />
          <path d="M62 78l10-6 10 6 10-6 10 6 10-6 10 6 10-6 8 6" fill="none" stroke={accent} strokeWidth="2" />
          <Band x={62} y={112} w={76} h={30} fill={accent} initial={initial} textFill={color} />
        </g>
      );
    default:
      return <rect x="64" y="60" width="72" height="104" rx="8" fill={color} />;
  }
}
