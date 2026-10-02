/** A shallow copy of `value` without `keys` — the immutable way to drop a
 *  field. Spelled as a destructure-and-rest, the dropped field needs a name
 *  nothing reads. */
export function omit<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}
