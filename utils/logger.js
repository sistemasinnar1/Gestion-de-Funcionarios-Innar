function info(message, data = {}) {
  const extra = Object.keys(data).length ? ` | ${JSON.stringify(data)}` : '';
  console.log(`[INFO] ${message}${extra}`);
}

function warn(message, data = {}) {
  const extra = Object.keys(data).length ? ` | ${JSON.stringify(data)}` : '';
  console.warn(`[WARN] ${message}${extra}`);
}

function error(message, data = {}) {
  const extra = Object.keys(data).length ? ` | ${JSON.stringify(data)}` : '';
  console.error(`[ERROR] ${message}${extra}`);
}

module.exports = { info, warn, error };
