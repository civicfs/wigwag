import { suppressSqliteExperimentalWarning } from '../warnings.js';

// Node emits the SQLite ExperimentalWarning while `node:sqlite` is being imported, before any code in the importing
// module runs. The CLI is therefore loaded dynamically, after the filter is in place.
suppressSqliteExperimentalWarning();
await import('./main.js');
