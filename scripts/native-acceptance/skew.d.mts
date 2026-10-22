export function initialSkewFailure(pane: string, submittedPrompts: number): boolean;
export function trustedSessionStart(pane: string): boolean;
export function hookTableSelection(pane: string, target: string): Array<'Down' | 'Up'> | undefined;
export function exactPendingPrompt(pane: string, expected: string): boolean;
export function ownedCliCommand(commandLine: string, root: string, allowed?: readonly string[]): boolean;
export function ownedDaemonSocket(path: string, codexHome: string, uid?: number): {
  path: string;
  target: string;
  dev: number;
  ino: number;
  uid: number;
} | undefined;
