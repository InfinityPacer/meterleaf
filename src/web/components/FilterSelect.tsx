import { Select } from "@base-ui/react/select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import type { ReactNode } from "react";
import "./controls.css";

export interface FilterSelectOption {
  value: string;
  label: string;
}

export interface FilterSelectProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  icon?: ReactNode;
  options: FilterSelectOption[];
}

/** 统一的自定义筛选选择器，避免不同页面回退到浏览器原生下拉菜单。 */
export function FilterSelect({
  label,
  value,
  onChange,
  icon,
  options,
}: FilterSelectProps) {
  return (
    <div className="filter-select">
      <Select.Root
        value={value}
        items={options}
        onValueChange={(next) => {
          if (typeof next === "string" && next !== value) onChange(next);
        }}
      >
        <Select.Trigger className="filter-select-trigger" aria-label={label}>
          {icon && (
            <span className="filter-select-icon" aria-hidden="true">
              {icon}
            </span>
          )}
          <Select.Value className="filter-select-value">
            {options.find((option) => option.value === value)?.label ?? value}
          </Select.Value>
          <Select.Icon className="filter-select-chevron">
            <ChevronDown size={15} aria-hidden="true" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner
            className="filter-select-positioner"
            sideOffset={6}
            align="start"
            alignItemWithTrigger={false}
          >
            <Select.Popup className="filter-select-popup">
              <Select.ScrollUpArrow className="filter-select-scroll-arrow">
                <ChevronUp size={15} aria-hidden="true" />
              </Select.ScrollUpArrow>
              <Select.List className="filter-select-list">
                {options.map((option) => (
                  <Select.Item
                    key={option.value}
                    value={option.value}
                    label={option.label}
                    className="filter-select-item"
                  >
                    <Select.ItemText>{option.label}</Select.ItemText>
                    <Select.ItemIndicator className="filter-select-indicator">
                      <Check size={15} aria-hidden="true" />
                    </Select.ItemIndicator>
                  </Select.Item>
                ))}
              </Select.List>
              <Select.ScrollDownArrow className="filter-select-scroll-arrow">
                <ChevronDown size={15} aria-hidden="true" />
              </Select.ScrollDownArrow>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}
