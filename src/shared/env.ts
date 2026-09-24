export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name} (see .env.example)`);
  }
  return value;
}

export function optionalEnv(name: string, fallback = ""): string {
  return process.env[name] || fallback;
}
