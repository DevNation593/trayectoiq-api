/** Tramo de espera para analytics: el evento no lleva el valor exacto (08_ANALYTICS_VALIDATION.md). */
export function waitingMinutesBucket(waitingSeconds: number): string {
  if (waitingSeconds <= 0) return '0';
  if (waitingSeconds <= 300) return '1-5';
  if (waitingSeconds <= 600) return '6-10';
  if (waitingSeconds <= 900) return '11-15';
  return '16+';
}
