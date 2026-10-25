export interface StreamForTokenTotals {
  tokenAddress: string;
  balance: string;
  withdrawn: string;
  status: 'ACTIVE' | 'CANCELLED';
}

export interface TokenTotal {
  tokenAddress: string;
  amount: string;
}

export interface TokenSummary {
  tokenAddress: string;
  streamCount: number;
}

export function committedTotalsByToken(streams: StreamForTokenTotals[]): TokenTotal[] {
  const totals = new Map<string, bigint>();

  for (const stream of streams) {
    const committed =
      stream.status === 'CANCELLED'
        ? BigInt(stream.withdrawn)
        : BigInt(stream.balance) + BigInt(stream.withdrawn);
    totals.set(stream.tokenAddress, (totals.get(stream.tokenAddress) ?? 0n) + committed);
  }

  return [...totals]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tokenAddress, amount]) => ({ tokenAddress, amount: amount.toString() }));
}

export function distinctTokensWithStreamCount(streams: StreamForTokenTotals[]): TokenSummary[] {
  const counts = new Map<string, number>();

  for (const stream of streams) {
    counts.set(stream.tokenAddress, (counts.get(stream.tokenAddress) ?? 0) + 1);
  }

  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tokenAddress, streamCount]) => ({ tokenAddress, streamCount }));
}
