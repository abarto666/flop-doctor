const SCALE = 10n ** 18n;

export function parseFlop(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,18})?$/.test(value)) throw new TypeError('Invalid FLOP decimal');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
}

export function formatFlop(planck) {
  const value = BigInt(planck);
  const sign = value < 0n ? '-' : '';
  const magnitude = value < 0n ? -value : value;
  const fraction = (magnitude % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return `${sign}${magnitude / SCALE}${fraction ? `.${fraction}` : ''}`;
}
