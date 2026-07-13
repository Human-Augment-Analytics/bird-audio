/**
 * Extracts the AudioMoth/recorder ID prefix from a filename or path, e.g.
 * "PSL2", "PSM5", "H12". Mirrors `find_device_id` in batch-core/src/export.rs
 * so the UI and the CSV metadata export agree on which device a file came from.
 */
export function findDeviceId(path: string): string | null {
  const matchPS = path.match(/PS[LMH]\d+/i);
  if (matchPS) return matchPS[0].toUpperCase();
  const matchH = path.match(/(?:^|[^a-zA-Z0-9])(H\d+)/i);
  if (matchH) return matchH[1].toUpperCase();
  return null;
}

export function getElevationBand(deviceId: string | null): "Low" | "Medium" | "High" | "Unknown" {
  if (!deviceId) return "Unknown";
  if (deviceId.startsWith("PSL")) return "Low";
  if (deviceId.startsWith("PSM")) return "Medium";
  if (deviceId.startsWith("PSH") || deviceId.startsWith("H")) return "High";
  return "Unknown";
}
