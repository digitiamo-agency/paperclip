import path from "node:path";
import { mkdirSync } from "node:fs";

/** Company-scoped LocalAuth data directory for one WhatsApp Web endpoint. */
export function whatsappWebSessionDir(input: {
  dataRoot?: string;
  companyId: string;
  endpointId: string;
}): string {
  const root =
    input.dataRoot ??
    process.env.PAPERCLIP_WHATSAPP_WEB_DATA_DIR ??
    path.join(process.cwd(), "data", "whatsapp-web");
  const dir = path.join(root, input.companyId, input.endpointId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function whatsappWebClientId(endpointId: string): string {
  return `endpoint-${endpointId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48)}`;
}
