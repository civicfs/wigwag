/** ANSI colors respect the user's terminal palette; labels carry meaning without color too. */
export const palette = {
  focus: 'cyan',
  role: 'magenta',
  muted: 'gray',
  success: 'green',
  warning: 'yellow',
  danger: 'red',
} as const;

export const sessionColor: Record<string, string> = {
  'online-idle': palette.success,
  'online-busy': palette.warning,
  offline: palette.muted,
};

export const deliveryColor: Record<string, string> = {
  pending: palette.warning,
  held: palette.warning,
  pushed: palette.focus,
  read: palette.success,
  failed: palette.danger,
  stuck: palette.danger,
};

export const priorityColor: Record<string, string> = {
  urgent: palette.danger,
  normal: palette.focus,
  low: palette.muted,
};
