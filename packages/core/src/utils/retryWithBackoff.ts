export const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  delayMs = 1000,
): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") {
      console.log("Retrying...");
      await new Promise(
        (resolve) => setTimeout(resolve, delayMs + delayMs * Math.random()), // Randomize the retry interval
      );
      return retryWithBackoff(fn);
    } else {
      throw e;
    }
  }
};

export const retryWithExponentialBackoff = async <T>(
  fn: () => Promise<T>,
  delayMs = 1000,
  maxAttempts = 5, // Maximum number of attempts
): Promise<T> => {
  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") {
        console.log(`Retrying... Attempt ${attempt + 1} of ${maxAttempts}`);
        await new Promise((resolve) =>
          setTimeout(resolve, delayMs * (attempt + 1)),
        );
        attempt++;
        return retryWithExponentialBackoff(fn);
      }
      throw e;
    }
  }
};
