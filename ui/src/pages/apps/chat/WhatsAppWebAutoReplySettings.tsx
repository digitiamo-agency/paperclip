import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  chatEndpointsApi,
  type ChatEndpoint,
} from "@/api/chatEndpoints";
import { queryKeys } from "@/lib/queryKeys";
import { useToast } from "@/context/ToastContext";
import type { WhatsAppWebAutoReplyMode } from "@paperclipai/shared";

const MODE_OPTIONS: Array<{
  value: WhatsAppWebAutoReplyMode;
  label: string;
  detail: string;
}> = [
  {
    value: "none",
    label: "Nessuno",
    detail: "Nessuna risposta automatica. I messaggi non avviano l’agente.",
  },
  {
    value: "all",
    label: "Tutti",
    detail: "Rispondi automaticamente a ogni DM in arrivo.",
  },
  {
    value: "allowlist",
    label: "Solo alcuni contatti",
    detail: "Rispondi solo ai numeri o chat id elencati sotto.",
  },
  {
    value: "blocklist",
    label: "Escludi alcuni contatti",
    detail: "Rispondi a tutti tranne i numeri o chat id elencati sotto.",
  },
  {
    value: "new_only",
    label: "Solo nuovi contatti",
    detail:
      "Rispondi solo al primo messaggio di un contatto mai visto. I successivi non avviano l’agente.",
  },
];

function contactsToText(contacts: string[]): string {
  return contacts.join("\n");
}

function textToContacts(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,;]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

export function WhatsAppWebAutoReplySettings({
  endpoint,
}: {
  endpoint: ChatEndpoint;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const current = endpoint.whatsappWebAutoReply ?? {
    mode: "none" as const,
    contacts: [],
    knownContacts: [],
  };
  const [mode, setMode] = useState<WhatsAppWebAutoReplyMode>(current.mode);
  const [contactsText, setContactsText] = useState(
    contactsToText(current.contacts),
  );

  useEffect(() => {
    setMode(current.mode);
    setContactsText(contactsToText(current.contacts));
  }, [current.mode, current.contacts.join("\n")]);

  const needsContacts = mode === "allowlist" || mode === "blocklist";
  const dirty = useMemo(() => {
    if (mode !== current.mode) return true;
    if (!needsContacts) return false;
    return (
      contactsToText(textToContacts(contactsText)) !==
      contactsToText(current.contacts)
    );
  }, [mode, contactsText, current.mode, current.contacts, needsContacts]);

  const save = useMutation({
    mutationFn: (input: {
      mode: WhatsAppWebAutoReplyMode;
      contacts?: string[];
      clearKnownContacts?: boolean;
    }) =>
      chatEndpointsApi.update(endpoint.id, {
        whatsappWebAutoReply: input,
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(
        queryKeys.chatEndpoints.detail(endpoint.id),
        next,
      );
      pushToast({
        title: "Policy aggiornata",
        body: "La risposta automatica WhatsApp Web è stata salvata.",
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: "Salvataggio non riuscito",
        body: error instanceof Error ? error.message : "Riprova.",
        tone: "error",
      }),
  });

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Risposta automatica</h2>
        <p className="text-sm text-muted-foreground">
          Di default non risponde a nessuno. Scegli chi può ricevere risposte
          automatiche dell’agente.
        </p>
      </div>
      <fieldset className="space-y-3">
        <legend className="sr-only">Modalità risposta automatica</legend>
        {MODE_OPTIONS.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3"
          >
            <input
              type="radio"
              name="whatsapp-web-auto-reply"
              className="mt-1"
              checked={mode === option.value}
              disabled={save.isPending}
              onChange={() => setMode(option.value)}
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="block text-sm text-muted-foreground">
                {option.detail}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {needsContacts && (
        <label className="grid gap-2 text-sm font-medium">
          Contatti (uno per riga)
          <Textarea
            value={contactsText}
            disabled={save.isPending}
            rows={6}
            placeholder={"393331234567\n15551234567@c.us"}
            onChange={(event) => setContactsText(event.target.value)}
          />
          <span className="text-sm font-normal text-muted-foreground">
            Usa il numero internazionale o il chat id WhatsApp (`…@c.us`).
          </span>
        </label>
      )}
      {mode === "new_only" && (
        <p className="text-sm text-muted-foreground">
          Contatti già visti: {current.knownContacts.length}. Puoi azzerare la
          memoria per trattarli di nuovo come nuovi.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={save.isPending || !dirty}
          onClick={() =>
            save.mutate({
              mode,
              ...(needsContacts
                ? { contacts: textToContacts(contactsText) }
                : {}),
            })
          }
        >
          {save.isPending ? "Salvataggio…" : "Salva policy"}
        </Button>
        {mode === "new_only" && current.knownContacts.length > 0 && (
          <Button
            variant="outline"
            disabled={save.isPending}
            onClick={() =>
              save.mutate({
                mode: "new_only",
                clearKnownContacts: true,
              })
            }
          >
            Azzera contatti noti
          </Button>
        )}
      </div>
    </div>
  );
}
