export type ErrorCode =
  | 'config'
  | 'bad_request'
  | 'not_found'
  | 'name_taken'
  | 'not_registered'
  | 'limit'
  | 'schema'
  | 'conflict'
  | 'forbidden'
  | 'not_implemented'
  | 'unbound'
  | 'transport'
  | 'integrity'
  | 'already_running'
  | 'internal';

export class WigwagError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'WigwagError';
  }
}
