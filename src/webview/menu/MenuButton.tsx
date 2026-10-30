// A button that opens a menu below it (AFD-18): the top bar's lens choice, "…" and run options.
import { type ReactNode, useRef, useState } from 'react';
import { Menu, type UiMenuEntry } from './Menu';

interface MenuButtonProps {
  /** Accessible name of the button and the menu. */
  label: string;
  children: ReactNode;
  items: () => UiMenuEntry[];
  className?: string;
  title?: string;
  disabled?: boolean;
}

export function MenuButton({
  label,
  children,
  items,
  className,
  title,
  disabled,
}: MenuButtonProps) {
  const button = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const open = () => {
    const r = button.current?.getBoundingClientRect();
    if (r) setAt({ x: r.left, y: r.bottom + 2 });
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className={className}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        title={title}
        disabled={disabled}
        onClick={() => (at ? setAt(null) : open())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            open();
          }
        }}
      >
        {children}
      </button>
      {at ? (
        <Menu
          x={at.x}
          y={at.y}
          label={label}
          items={items()}
          opener={button.current}
          onClose={() => setAt(null)}
        />
      ) : null}
    </>
  );
}
