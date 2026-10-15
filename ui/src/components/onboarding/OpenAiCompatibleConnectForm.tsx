import { Loader2 } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { OnboardingLoginCard } from "../AdapterLoginChrome";

export type OpenAiCompatibleModelOption = { id: string; label: string };

/**
 * Connect-step form for an OpenAI-compatible Chat Completions endpoint:
 * base URL, optional API key, catalog load, then model selection.
 */
export function OpenAiCompatibleConnectForm({
  baseUrl,
  apiKey,
  model,
  models,
  loading,
  error,
  disabled,
  onBaseUrlChange,
  onApiKeyChange,
  onModelChange,
  onLoadModels,
}: {
  baseUrl: string;
  apiKey: string;
  model: string;
  models: OpenAiCompatibleModelOption[];
  loading: boolean;
  error: string | null;
  disabled?: boolean;
  onBaseUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onLoadModels: () => void;
}) {
  return (
    <OnboardingLoginCard instruction="Connect an OpenAI-compatible endpoint">
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="openai-compatible-base-url">Base URL</Label>
          <Input
            id="openai-compatible-base-url"
            autoFocus
            disabled={disabled || loading}
            placeholder="https://api.example.com/v1"
            value={baseUrl}
            onChange={(e) => onBaseUrlChange(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            OpenAI-compatible Chat Completions root (usually ends with /v1).
            HTTPS, or HTTP on loopback / private LAN.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="openai-compatible-api-key">API key (optional)</Label>
          <Input
            id="openai-compatible-api-key"
            type="password"
            autoComplete="off"
            disabled={disabled || loading}
            placeholder="Leave empty when the server needs no auth"
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={disabled || loading || !baseUrl.trim()}
            onClick={onLoadModels}
          >
            {loading ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                Loading models…
              </span>
            ) : (
              "Load models"
            )}
          </Button>
          {models.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {models.length} model{models.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        {error && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="openai-compatible-model">Model</Label>
          <Select
            value={model || undefined}
            onValueChange={onModelChange}
            disabled={disabled || loading || models.length === 0}
          >
            <SelectTrigger id="openai-compatible-model" className="w-full">
              <SelectValue
                placeholder={
                  models.length === 0
                    ? "Load models to choose one"
                    : "Select a model"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {models.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </OnboardingLoginCard>
  );
}
