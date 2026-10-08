export type PauseReason = symbol;

export function createPauseController<T>(send: (paused: boolean) => Promise<T>) {
  const reasons = new Set<PauseReason>();
  let requested: boolean | undefined = false;
  let pending: Promise<T | void> = Promise.resolve();
  return (reason: PauseReason, active: boolean): Promise<T | void> => {
    if (active) reasons.add(reason);
    else reasons.delete(reason);
    const paused = reasons.size > 0;
    if (paused === requested) return pending;
    requested = paused;
    // Capture each transition and send it after the previous request finishes.
    const next = pending.catch(() => {}).then(() => send(paused));
    pending = next;
    void next.catch(() => { if (pending === next) requested = undefined; });
    return next;
  };
}
