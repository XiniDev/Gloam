import type { SVGProps } from "react";

/**
 * Light-source icons (SPEC §30.1 grammar: 24 × 24, 1.75 strokes, round caps and joins, currentColor), one silhouette
 * each so they tell apart by shape alone: a torch (a flame on a slanted haft), a candle (a stub with its flame), an oil
 * lamp (a low boat with a flame at its spout), a hooded lantern (a caged lantern under its hood), a bullseye lantern
 * (a lantern throwing a cone). And what's done with a light: lit (a lantern with its flame and rays), put out (the
 * lantern shuttered, no flame), placed (a lantern over the mark where it stands).
 */
type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  );
}

export function TorchIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M8.5 21.5 13 12" />
      <path d="M11.4 12.6h3.4" />
      <path d="M14.4 10.8c-2.2-.9-3.2-3-1.6-5.6.3 1.3 1.1 1.9 1.9 1.6-.3-1.5.1-2.9 1.3-4.3.3 2.4 2.4 3.8 1.3 6.4-.5 1.3-1.6 2.1-2.9 1.9Z" />
    </Svg>
  );
}

export function CandleIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M9 11.5h6v9H9z" />
      <path d="M7 20.5h10" />
      <path d="M12 11.5V10" />
      <path d="M12 8.6c-1.5-.6-1.9-2.3-.1-4.6.5 1.4 1.9 2.2 1.4 3.6-.2.6-.7 1-1.3 1Z" />
    </Svg>
  );
}

export function OilLampIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M3.5 14.5h13c-.7 2.6-3 4-6.5 4s-5.8-1.4-6.5-4Z" />
      <path d="M16.5 14.5 20 12.5" />
      <path d="M8 18.5v2h4v-2" />
      <path d="M20.2 10.8c-1.3-.5-1.6-1.9-.1-3.8.4 1.2 1.6 1.8 1.2 3-.2.5-.6.8-1.1.8Z" />
    </Svg>
  );
}

export function HoodedLanternIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M12 2.5v1.5" />
      <path d="M7 8 8.5 4h7L17 8Z" />
      <path d="M8 8h8v10H8z" />
      <path d="M10.7 8v10M13.3 8v10" />
      <path d="M6.5 20.5h11" />
      <path d="M8 18l-1.5 2.5M16 18l1.5 2.5" />
    </Svg>
  );
}

export function BullseyeLanternIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M3 8h7v9H3z" />
      <path d="M6.5 5v3" />
      <circle cx="10" cy="12.5" r="2" />
      <path d="M12 12.5 21 7M12 12.5l9 5.5" />
      <path d="M21 7v11" strokeDasharray="1.5 2" />
    </Svg>
  );
}

/** Light it: a lantern with its flame burning and its light thrown out. */
export function LanternLitIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M12 2.5v1.5" />
      <path d="M8.2 7.5 9.3 4.5h5.4l1.1 3Z" />
      <path d="M8.7 7.5h6.6v10H8.7z" />
      <path
        d="M12 15.4c-1.2-.5-1.5-1.8-.1-3.6.4 1.1 1.5 1.7 1.1 2.8-.2.5-.5.8-1 .8Z"
        fill="currentColor"
        stroke="none"
      />
      <path d="M7 20.5h10" />
      <path d="M5 11.5H3M21 11.5h-2M5.6 7 4.2 5.6M18.4 7l1.4-1.4" />
    </Svg>
  );
}

/** Put it out: the lantern shuttered, its slats closed, no flame. */
export function LanternOutIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M12 2.5v1.5" />
      <path d="M8.2 7.5 9.3 4.5h5.4l1.1 3Z" />
      <path d="M8.7 7.5h6.6v10H8.7z" />
      <path d="M8.7 10.8h6.6M8.7 14.1h6.6" />
      <path d="M7 20.5h10" />
    </Svg>
  );
}

/** Place a light on the board: a lantern standing over the mark on the ground where it goes. */
export function PlaceLightIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M12 2v1.3" />
      <path d="M9.2 6.3l.9-2.6h3.8l.9 2.6Z" />
      <path d="M9.6 6.3h4.8v7.2H9.6z" />
      <path
        d="M12 11.8c-.9-.4-1.1-1.3-.1-2.6.3.8 1.1 1.2.8 2-.1.4-.4.6-.7.6Z"
        fill="currentColor"
        stroke="none"
      />
      <ellipse cx="12" cy="19" rx="7.5" ry="2.4" strokeDasharray="2 1.8" />
      <path d="M12 13.5V19" strokeWidth={1.2} />
    </Svg>
  );
}

/** The icon for a light preset id. */
export function LightPresetIcon({ preset, size = 18 }: { preset: string; size?: number }) {
  switch (preset) {
    case "candle":
      return <CandleIcon size={size} />;
    case "lamp":
      return <OilLampIcon size={size} />;
    case "hooded-lantern":
      return <HoodedLanternIcon size={size} />;
    case "bullseye-lantern":
      return <BullseyeLanternIcon size={size} />;
    default:
      return <TorchIcon size={size} />;
  }
}
