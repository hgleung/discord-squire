interface StarRatingProps {
  rating: number | null;
  size?: number;
}

export function StarRating({ rating, size = 22 }: StarRatingProps) {
  const value = rating ?? 0;
  const pct = Math.max(0, Math.min(100, (value / 5) * 100));
  const stars = '★★★★★';

  return (
    <span className="relative inline-block leading-none select-none" style={{ fontSize: size }}>
      <span className="text-neutral-200">{stars}</span>
      <span
        className="absolute inset-0 overflow-hidden text-violet-500"
        style={{ width: `${pct}%` }}
      >
        {stars}
      </span>
    </span>
  );
}
