interface ProgressRingProps {
  percent: number | null;
  size?: number;
  strokeWidth?: number;
  active?: boolean;
}

export function ProgressRing({ percent, size = 44, strokeWidth = 4, active = false }: ProgressRingProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const value = percent ?? 0;
  const offset = circumference - (value / 100) * circumference;
  const trackColor = '#eceaf1';
  const fillColor = active ? '#7c3aed' : percent === null ? '#d8d5e0' : '#4c8bf5';

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={trackColor} strokeWidth={strokeWidth} />
        {percent !== null && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={fillColor}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
          />
        )}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-[11px] font-medium text-neutral-500">
        {percent === null ? '–' : `${Math.round(percent)}%`}
      </div>
    </div>
  );
}
