import { Text as InkText } from 'ink';
import { Children, type ComponentProps } from 'react';
import { terminalText } from '../terminal.js';

/** Escape data before Ink adds its own trusted color/style sequences. */
export function Text(props: ComponentProps<typeof InkText>) {
  return (
    <InkText {...props}>
      {Children.map(props.children, (child) => (typeof child === 'string' ? terminalText(child) : child))}
    </InkText>
  );
}
