export interface TabItem<T extends string = string> {
  key: T;
  label: string;
}

export interface TabsProps<T extends string = string> {
  items: TabItem<T>[];
  active: T;
  onChange: (key: T) => void;
  "aria-label"?: string;
}

export function Tabs<T extends string = string>({ items, active, onChange, ...rest }: TabsProps<T>) {
  return (
    <div className="ui-tabs" role="tablist" {...rest}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={active === item.key}
          className={`ui-tabs__tab${active === item.key ? " is-active" : ""}`}
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
