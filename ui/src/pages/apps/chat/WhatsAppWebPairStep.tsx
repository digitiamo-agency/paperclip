import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { SetupWizardFooter } from "@/components/SetupWizard";
import {
  chatEndpointsApi,
  type ChatEndpoint,
  type ChatEndpointSetupAction,
  type WhatsAppWebPairingStatus,
} from "@/api/chatEndpoints";
import { sanitizedSetupErrorMessage } from "./chat-setup-error";

export function WhatsAppWebPairStep({
  endpoint,
  agentName,
  repairing,
  pending,
  onAction,
  onRefresh,
  onSaveExit,
}: {
  endpoint: ChatEndpoint;
  agentName: string;
  repairing: boolean;
  pending: boolean;
  onAction(
    action: ChatEndpointSetupAction,
    values?: Record<string, string>,
  ): void;
  onRefresh(): void;
  onSaveExit(): void;
}) {
  const [started, setStarted] = useState(Boolean(endpoint.botExternalId));
  const pairingQuery = useQuery({
    queryKey: ["chat-endpoints", endpoint.id, "whatsapp-web-pairing"],
    queryFn: () => chatEndpointsApi.getWhatsAppWebPairingStatus(endpoint.id),
    enabled: started,
    refetchInterval: (query) => {
      const phase = query.state.data?.phase;
      if (phase === "ready" || phase === "failed") return false;
      return 1500;
    },
  });
  const startMutation = useMutation({
    mutationFn: () => chatEndpointsApi.startWhatsAppWebPairing(endpoint.id),
    onSuccess: () => {
      setStarted(true);
      void pairingQuery.refetch();
      onRefresh();
    },
  });

  const status: WhatsAppWebPairingStatus | undefined =
    pairingQuery.data ?? startMutation.data;
  const ready = status?.phase === "ready" || Boolean(endpoint.botExternalId);
  const failed = status?.phase === "failed";
  const busy =
    pending ||
    startMutation.isPending ||
    status?.phase === "starting" ||
    status?.phase === "authenticated";

  useEffect(() => {
    if (status?.phase === "ready") onRefresh();
  }, [status?.phase, onRefresh]);

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h1 className="text-xl font-bold">Pair WhatsApp Web</h1>
        <p className="text-sm text-muted-foreground">
          Connect {agentName} by scanning a QR code with WhatsApp on your phone.
          This uses the unofficial WhatsApp Web client and a local Chromium
          session on this Paperclip instance. No public webhook URL is required.
        </p>
        <p className="rounded-md bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
          WhatsApp may restrict unofficial clients. Prefer a dedicated number for
          agent work. V1 supports direct messages with text only. After setup,
          automatic replies stay off until you choose who may receive them in
          Settings.
        </p>
        {repairing && (
          <p className="text-sm text-muted-foreground">
            Re-pair keeps this channel identity when the same WhatsApp account is
            scanned again.
          </p>
        )}
      </div>

      {started && status?.qrDataUrl && status.phase === "pending_qr" && (
        <div className="flex flex-col items-start gap-3">
          <img
            src={status.qrDataUrl}
            alt="WhatsApp Web pairing QR code"
            className="size-64 rounded-md border border-border bg-background p-2"
          />
          <p className="text-sm text-muted-foreground">
            Open WhatsApp on your phone → Linked devices → Link a device, then
            scan this code.
          </p>
        </div>
      )}
      {started && status?.phase === "authenticated" && (
        <p className="text-sm text-muted-foreground">
          Authenticated. Waiting for WhatsApp Web to become ready…
        </p>
      )}
      {ready && (
        <div className="space-y-2">
          <p className="text-sm">
            Paired as{" "}
            <span className="font-medium">
              {status?.pushName ||
                endpoint.botUsername ||
                status?.wid ||
                endpoint.botExternalId}
            </span>
          </p>
          <p className="text-sm text-muted-foreground">
            Send a direct message to this WhatsApp account to continue setup.
          </p>
        </div>
      )}
      {(startMutation.isError || pairingQuery.isError || failed) && (
        <p role="alert" className="text-sm text-destructive">
          {status?.error ||
            sanitizedSetupErrorMessage(
              startMutation.error ?? pairingQuery.error,
              {},
            )}
        </p>
      )}

      <SetupWizardFooter onSaveExit={onSaveExit} disabled={busy}>
        {!started ? (
          <Button disabled={busy} onClick={() => startMutation.mutate()}>
            Show QR code
          </Button>
        ) : ready ? (
          <Button disabled={pending} onClick={() => onAction("verify")}>
            Continue
          </Button>
        ) : (
          <Button disabled={busy} onClick={() => startMutation.mutate()}>
            Refresh QR
          </Button>
        )}
      </SetupWizardFooter>
    </div>
  );
}
