import { runLocalService } from '@mosaic/local-runtime';

// This process deliberately has no signing, unlocking, storage, XMTP, or API
// behavior yet. It establishes the custody boundary before those features land.
runLocalService('signer-policy-manager');
