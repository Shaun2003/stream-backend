function buildPublicBaseUrl(req) {
  const protoHeader = req && req.headers && (req.headers['x-forwarded-proto'] || req.headers['X-Forwarded-Proto']);
  const isHttps = protoHeader === 'https' || (req && req.secure) || (req && req.protocol === 'https');
  const scheme = isHttps ? 'https' : 'http';
  const host = (req && req.headers && req.headers.host) || 'localhost';
  return `${scheme}://${host}`;
}

module.exports = { buildPublicBaseUrl };
