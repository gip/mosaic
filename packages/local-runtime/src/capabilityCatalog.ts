import {
  type CapabilityOperation,
  type GrantableCapabilityOperation,
  isGrantableCapability,
} from './contracts.js';

export const GRANTABLE_CAPABILITIES = Object.freeze([
  'state.get',
  'state.put',
  'state.compareAndSet',
  'log.emit',
  'clock.now',
  'random.bytes',
  'xmtp.send',
  'xmtp.receive',
] satisfies GrantableCapabilityOperation[]);

export function assertGrantableCapability(operation: CapabilityOperation): asserts operation is GrantableCapabilityOperation {
  if (!isGrantableCapability(operation)) throw new Error(`${operation} policy broker is not implemented`);
}
