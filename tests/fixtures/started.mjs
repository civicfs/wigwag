// Preloaded with `node --import` into a child spawned with a fourth stdio pipe: writes one byte to that pipe the moment
// node is running JavaScript, so a test can time a bound from "the process started" instead of from the spawn call
// (fork/exec of a cold node stalls for seconds when the machine is loaded).
import { writeSync } from 'node:fs';

writeSync(3, 'started');
