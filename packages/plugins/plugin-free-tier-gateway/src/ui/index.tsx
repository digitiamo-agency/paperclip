import { useState } from "react";
import { usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";

interface KeyStatus {
  id: string;
  provider: string;
  disabled: boolean;
  coolingDown: boolean;
  requests: number;
  rateLimited: number;
  requestsToday: number;
  tokensToday: number;
  limits: { rpm?: number; rpd?: number; tpd?: number };
}

interface GatewayStatus {
  listening: boolean;
  configured: boolean;
  baseUrl: string;
  token: string;
  virtualModels: string[];
  auto: { model: string; candidates: string[] } | null;
  keys: KeyStatus[];
}

function budget(used: number, max?: number): string {
  return max ? `${used}/${max}` : `${used}`;
}

function keyState(k: KeyStatus): string {
  return k.disabled ? "disabled (auth error)" : k.coolingDown ? "cooling down" : "ready";
}

export function GatewayStatusWidget({ context }: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<GatewayStatus>("status", { companyId: context.companyId });
  const [copied, setCopied] = useState<"url" | "token" | null>(null);

  if (loading) return <div>Loading…</div>;
  if (error || !data) return <div role="alert">Gateway status unavailable{error ? `: ${error.message}` : ""}</div>;

  if (!data.configured) return <div>Not configured for this company. Add keys in the plugin settings.</div>;

  const copy = async (what: "url" | "token") => {
    try {
      await navigator.clipboard.writeText(what === "url" ? data.baseUrl : data.token);
      setCopied(what);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard can be blocked; the operator can still read the URL above.
    }
  };

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <strong>{data.listening ? "Listening" : "Not running"}</strong>
      {data.listening && (
        <>
          <div>
            <code>{data.baseUrl}</code>{" "}
            <button type="button" onClick={() => copy("url")}>{copied === "url" ? "Copied" : "Copy URL"}</button>{" "}
            <button type="button" onClick={() => copy("token")}>{copied === "token" ? "Copied" : "Copy token"}</button>
          </div>
          <div style={{ opacity: 0.7 }}>
            Models: {data.virtualModels.length ? data.virtualModels.join(", ") : "none configured"}
            {data.auto ? ` · auto routes between ${data.auto.candidates.join(", ")} using ${data.auto.model}` : ""}
          </div>
        </>
      )}
      {data.keys.length === 0 ? (
        <div style={{ opacity: 0.7 }}>No keys configured. Add them in the plugin settings.</div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 16 }}>
          {data.keys.map((k) => (
            <li key={k.id}>
              {k.id}: {keyState(k)} · today {budget(k.requestsToday, k.limits.rpd)} requests
              {k.limits.tpd ? ` · ${budget(k.tokensToday, k.limits.tpd)} tokens` : ""} · {k.rateLimited} rate-limited
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
