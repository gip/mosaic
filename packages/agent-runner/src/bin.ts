import { runLocalService } from '@mosaic/local-runtime';

// Execution and state are intentionally deferred. For this slice the runner is
// only an independently supervised process.
runLocalService('agent-runner');
