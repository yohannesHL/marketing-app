export const withRetry = async <T>(
  fn: () => Promise<T>,
  retries = 3,
): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (retries === 0) throw err;
    await new Promise((r) => setTimeout(r, 500));
    return withRetry(fn, retries - 1);
  }
};
