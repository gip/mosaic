import { assertPositiveDecimal, type Asset, type TransferIntent } from '@mosaic/chain-core';
import { Client, isValidClassicAddress, xrpToDrops, type Payment } from 'xrpl';
import { normalizeCurrency, XRPL_WS_ENDPOINTS } from './adapter.js';

export interface PreparedXrplTransfer {
  kind: 'xrpl';
  unsignedTransaction: Payment;
  fee: string;
  feeSymbol: 'XRP';
  reserveImpact: string | null;
  expiresAt: string;
}

function amount(asset: Asset, value: string): Payment['Amount'] {
  assertPositiveDecimal(value, 'amount');
  if (asset.kind === 'native') return xrpToDrops(value);
  return { currency: asset.currencyCode ?? asset.code, issuer: asset.issuer, value };
}

export async function prepareXrplTransfer(
  intent: TransferIntent,
  sourceTag: number,
  clientFactory: (url: string) => Client = (url) => new Client(url),
): Promise<PreparedXrplTransfer> {
  if (intent.chain !== 'xrpl') throw new Error('XRPL transfer requires the xrpl chain');
  if (!isValidClassicAddress(intent.sourceAddress) || !isValidClassicAddress(intent.destinationAddress)) {
    throw new Error('invalid XRPL account address');
  }
  if (intent.sourceAddress === intent.destinationAddress) throw new Error('source and destination must differ');
  if (!Number.isInteger(sourceTag) || sourceTag < 0 || sourceTag > 0xffff_ffff) throw new Error('invalid XRPL SourceTag');
  const client = clientFactory(XRPL_WS_ENDPOINTS[intent.network]);
  await client.connect();
  try {
    if (intent.asset.kind === 'issued') {
      const issued = intent.asset;
      const lines = await client.request({
        command: 'account_lines', account: intent.destinationAddress,
        peer: issued.issuer, ledger_index: 'validated',
      });
      const currency = normalizeCurrency(issued.currencyCode ?? issued.code);
      const trusted = lines.result.lines.some((line) => normalizeCurrency(line.currency) === currency && line.account === issued.issuer);
      if (!trusted) throw new Error('the XRPL destination does not trust this issued asset');
    }
    const prepared = await client.autofill({
      TransactionType: 'Payment', Account: intent.sourceAddress, Destination: intent.destinationAddress,
      Amount: amount(intent.asset, intent.amount), SourceTag: sourceTag,
    } as Payment) as Payment;
    return {
      kind: 'xrpl', unsignedTransaction: prepared,
      fee: String(prepared.Fee ? Number(prepared.Fee) / 1_000_000 : 0), feeSymbol: 'XRP',
      reserveImpact: intent.asset.kind === 'native' ? 'A new destination account must receive at least the current XRPL base reserve.' : null,
      expiresAt: new Date(Date.now() + 3 * 60_000).toISOString(),
    };
  } finally {
    await client.disconnect();
  }
}
