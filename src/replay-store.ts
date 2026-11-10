export interface ReplayStore {
  claim(tokenId: string, expiresAt: Date): Promise<boolean>;
}

export function memoryReplayStore(now: () => number = Date.now): ReplayStore {
  const claimed = new Map<string, number>();

  function sweep(currentTime: number): void {
    for (const [tokenId, expiresAt] of claimed) {
      if (expiresAt <= currentTime) claimed.delete(tokenId);
    }
  }

  return {
    async claim(tokenId, expiresAt) {
      const currentTime = now();
      sweep(currentTime);
      if (claimed.has(tokenId)) return false;
      claimed.set(tokenId, expiresAt.getTime());
      return true;
    },
  };
}
