import Image from "next/image";

/**
 * A book cover, or a placeholder.
 *
 * The placeholder matters more than it sounds: v2 rendered `<img src="">` when a
 * book had no cover, because its `coverImagePath` virtual returned undefined,
 * and browsers respond to an empty src by re-requesting the current page. A
 * missing cover should be a shape on the screen, not a second page load.
 */
export function Cover({
  cover,
  title,
  size = "medium",
}: {
  cover: { storageKey: string; width: number; height: number } | null;
  title: string;
  size?: "small" | "medium" | "large";
}) {
  const dimensions = {
    small: { w: 48, h: 72 },
    medium: { w: 128, h: 192 },
    large: { w: 200, h: 300 },
  }[size];

  if (!cover) {
    return (
      <div
        aria-hidden
        style={{ width: dimensions.w, height: dimensions.h }}
        className="flex shrink-0 items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50 text-center text-[10px] leading-tight text-slate-400 dark:border-slate-700 dark:bg-slate-900"
      >
        No cover
      </div>
    );
  }

  return (
    <Image
      src={`/api/covers/${cover.storageKey}`}
      // Decorative in context — the title is always rendered as text beside it,
      // so repeating it here would just make a screen reader say it twice.
      alt=""
      width={dimensions.w}
      height={dimensions.h}
      // The stored image is bounded at 800x1200 and the intrinsic ratio is
      // preserved, so `object-contain` avoids distorting an unusual shape.
      className="h-auto shrink-0 rounded border border-slate-200 object-contain dark:border-slate-800"
      // Content-addressed URLs never change contents, so this is safe to keep.
      unoptimized={false}
      title={title}
    />
  );
}
