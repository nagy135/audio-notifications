export function logEvent(event, details = {}) {
  console.log(
    JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }),
  );
}
