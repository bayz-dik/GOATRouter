import type { FluxIconKey } from "./identity";

/**
 * Monochrome provider mark.
 *
 * Every glyph is a local, hand-written SVG path. Provider metadata can only choose
 * *which* local mark to draw — it can never supply markup, a URL, or a data URI, so
 * provider icon information is not an injection surface and adds no remote
 * dependency. An unrecognized key resolves to the generic mark plus initials.
 */

const STROKE = { stroke: "currentColor", strokeWidth: 1.4, fill: "none" } as const;

function Glyph({ iconKey }: { iconKey: FluxIconKey }) {
  switch (iconKey) {
    case "openrouter":
      // Three sources converging on one outlet.
      return (
        <>
          <path d="M2 4h5l4 6 4-6h5" {...STROKE} />
          <path d="M2 16h5l4-6" {...STROKE} />
          <circle cx="19" cy="16" r="2" {...STROKE} />
        </>
      );
    case "gemini":
      // Four-point star.
      return <path d="M11 2l2.6 6.4L20 11l-6.4 2.6L11 20l-2.6-6.4L2 11l6.4-2.6z" {...STROKE} />;
    case "codex":
      // Angle brackets.
      return (
        <>
          <path d="M8 5L3 11l5 6" {...STROKE} />
          <path d="M14 5l5 6-5 6" {...STROKE} />
        </>
      );
    case "tabitoken":
      // Stacked token discs.
      return (
        <>
          <ellipse cx="11" cy="6" rx="7" ry="3" {...STROKE} />
          <path d="M4 6v5c0 1.7 3.1 3 7 3s7-1.3 7-3V6" {...STROKE} />
          <path d="M4 11v4c0 1.7 3.1 3 7 3s7-1.3 7-3v-4" {...STROKE} />
        </>
      );
    case "openai":
      // Interlocked hex outline.
      return <path d="M11 2l7.8 4.5v9L11 20l-7.8-4.5v-9z" {...STROKE} />;
    case "anthropic":
      // Converging chevron.
      return (
        <>
          <path d="M4 18L11 4l7 14" {...STROKE} />
          <path d="M7.5 13h7" {...STROKE} />
        </>
      );
    case "custom":
      // Dashed square: operator-defined endpoint.
      return (
        <rect x="3.5" y="3.5" width="15" height="15" strokeDasharray="3 2.4" {...STROKE} />
      );
    default:
      // Generic node: a ring, paired with initials for identity.
      return <circle cx="11" cy="11" r="7.5" {...STROKE} />;
  }
}

export type ProviderMarkProps = {
  iconKey: FluxIconKey;
  initials: string;
};

export function ProviderMark({ iconKey, initials }: ProviderMarkProps) {
  const generic = iconKey === "generic" || iconKey === "custom";
  return (
    <span className="provider-mark" aria-hidden="true">
      <svg viewBox="0 0 22 22" width="18" height="18" focusable="false">
        <Glyph iconKey={iconKey} />
      </svg>
      {/*
        Initials accompany the fallback marks so a custom provider is still
        identifiable at a glance. Rendered as text, never as markup.
      */}
      {generic && <i className="provider-initials">{initials}</i>}
    </span>
  );
}
