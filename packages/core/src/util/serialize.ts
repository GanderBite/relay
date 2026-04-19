/**
 * Returns a `serialize` function that chains every call onto the tail of the
 * previous in-flight promise so tasks execute strictly in submission order.
 * A failed task does not break the chain — the next task still runs once
 * the previous one settles. Readers are never blocked; final on-disk state
 * is last-writer-wins.
 *
 * Use one serializer per resource (e.g. one per file path). The returned
 * value is whatever the task resolves to — typically a neverthrow `Result`
 * — so callers compose without losing typed errors.
 */
export function createWriteSerializer(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(
      () => task(),
      () => task(),
    );
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}
