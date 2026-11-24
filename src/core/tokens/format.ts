// Token numbers as text: `512`, `1.2k`, `32k`.
export const formatTokens = (t: number): string =>
  t >= 1024 && t % 1024 === 0 ? `${t / 1024}k` : t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);
