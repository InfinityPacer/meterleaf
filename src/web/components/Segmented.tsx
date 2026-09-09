/** 同类互斥选项统一使用相同的布局、选中层与键盘按钮语义。 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {value === option.value && <span className="segment-active" />}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}
