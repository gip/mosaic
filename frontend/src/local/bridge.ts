/** Electron exposes this narrow bridge; it is absent in a normal browser. */
export function localBridge(): Window['mosaicLocal'] {
  return window.mosaicLocal;
}

export function isLocalApp(): boolean {
  return localBridge() !== undefined;
}
