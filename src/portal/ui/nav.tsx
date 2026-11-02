import {type KeyboardEvent, type ReactNode, useId, useRef} from 'react';

/** Arrow keys move between the buttons of a group (tabs, segments), as screen reader users expect. */
function useRovingKeys(count: number, index: number, pick: (index: number) => void) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent) => {
    const step = {ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1}[event.key];
    const to = step ? (index + step + count) % count : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : null;
    if (to === null) return;
    event.preventDefault();
    pick(to);
    refs.current[to]?.focus();
  };
  return {refs, onKeyDown};
}

/**
 * Tabs switch between VIEWS of one screen (Profile · Security · Devices).
 * The selected tab's content is `children`. Keep the selected tab in the URL
 * (a search param) when people will want to link to it.
 */
export function Tabs<V extends string>({
  items,
  value,
  onChange,
  label,
  children,
}: {
  items: {value: V; label: ReactNode; count?: number}[];
  value: V;
  onChange: (value: V) => void;
  /** What the tabs are for, for screen readers ("Account sections"). */
  label: string;
  children: ReactNode;
}) {
  const id = useId();
  const index = Math.max(0, items.findIndex(item => item.value === value));
  const {refs, onKeyDown} = useRovingKeys(items.length, index, i => onChange(items[i]!.value));
  return (
    <div className="tabs">
      <div className="tab-list" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {items.map((item, i) => (
          <button
            key={item.value}
            ref={node => {
              refs.current[i] = node;
            }}
            type="button"
            role="tab"
            className="tab"
            id={`${id}-tab-${item.value}`}
            aria-selected={item.value === value}
            aria-controls={`${id}-panel`}
            tabIndex={item.value === value ? 0 : -1}
            onClick={() => onChange(item.value)}>
            {item.label}
            {item.count !== undefined && <span className="tab-count">{item.count}</span>}
          </button>
        ))}
      </div>
      <div className="tab-panel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${value}`} tabIndex={0}>
        {children}
      </div>
    </div>
  );
}

/**
 * Two to four mutually exclusive options that FILTER or switch what is shown
 * right here (All · Active · Suspended; Week · Month). Not navigation.
 */
export function SegmentedControl<V extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: {value: V; label: ReactNode}[];
  value: V;
  onChange: (value: V) => void;
  label: string;
}) {
  const index = Math.max(0, options.findIndex(option => option.value === value));
  const {refs, onKeyDown} = useRovingKeys(options.length, index, i => onChange(options[i]!.value));
  return (
    <div className="segmented" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((option, i) => (
        <button
          key={option.value}
          ref={node => {
            refs.current[i] = node;
          }}
          type="button"
          role="radio"
          className="segment"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}
