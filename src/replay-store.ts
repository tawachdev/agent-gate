export interface ReplayStore {
  claim(tokenId: string, expiresAt: Date): Promise<boolean>;
}

const SWEEP_INTERVAL_MS = 60_000;

export function memoryReplayStore(now: () => number = Date.now): ReplayStore {
  const claimed = new Map<string, number>();
  let nextSweepAt = 0;

  function sweep(currentTime: number): void {
    for (const [tokenId, expiresAt] of claimed) {
      if (expiresAt <= currentTime) claimed.delete(tokenId);
    }
  }

  return {
    async claim(tokenId, expiresAt) {
      const currentTime = now();
      if (currentTime >= nextSweepAt) {
        sweep(currentTime);
        nextSweepAt = currentTime + SWEEP_INTERVAL_MS;
      }
      if (claimed.has(tokenId)) return false;
      claimed.set(tokenId, expiresAt.getTime());
      return true;
    },
  };
}
