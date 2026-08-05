import { cn } from "@/lib/utils";
import { BRAND, emblemForSize } from "./assets";

/**
 * Transparent emblem. The PNG carries its own alpha channel, so it is never
 * placed on a hardcoded backdrop — it inherits whatever surface it sits on.
 */
export function BrandMark({
  size = 40,
  className,
  decorative = false,
}: {
  size?: number;
  className?: string;
  decorative?: boolean;
}) {
  return (
    <img
      src={emblemForSize(size)}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      alt={decorative ? "" : `${BRAND.name} emblem`}
      aria-hidden={decorative || undefined}
      className={cn("block select-none object-contain", className)}
      style={{ width: size, height: size, backgroundColor: "transparent" }}
    />
  );
}

/** Emblem + wordmark lockup used in headers and sign-in surfaces. */
export function BrandLockup({
  size = 44,
  showTagline = true,
  className,
}: {
  size?: number;
  showTagline?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("flex items-center gap-3", className)}>
      <BrandMark size={size} decorative />
      <span className="flex flex-col leading-none">
        <span className="font-display text-lg font-semibold uppercase tracking-[0.18em]">
          {BRAND.name}
        </span>
        {showTagline ? (
          <span className="mt-1 text-[10px] uppercase tracking-[0.16em] opacity-70">
            {BRAND.tagline}
          </span>
        ) : null}
      </span>
    </span>
  );
}

/** Full horizontal lockup master, for wide hero and print-style contexts. */
export function BrandHorizontal({
  className,
  width = 320,
}: {
  className?: string;
  width?: number;
}) {
  return (
    <img
      src={BRAND.horizontal}
      alt={`${BRAND.name} logo`}
      width={width}
      height={Math.round((width * 1024) / 1536)}
      loading="lazy"
      decoding="async"
      className={cn("block h-auto max-w-full select-none object-contain", className)}
      style={{ width, backgroundColor: "transparent" }}
    />
  );
}
