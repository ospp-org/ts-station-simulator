export class DelaySimulator {
  async delay(range: [number, number]): Promise<void> {
    const [min, max] = range;
    if (min <= 0 && max <= 0) return;
    const ms = min + Math.random() * (max - min);
    return new Promise(resolve => setTimeout(resolve, Math.round(ms)));
  }
}
