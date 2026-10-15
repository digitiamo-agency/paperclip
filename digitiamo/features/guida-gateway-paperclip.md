# Guida all'Integrazione di LLM Gateway Free Tier con Paperclip

Questa guida riassume l'architettura e i passi necessari per configurare un gateway open-source di modelli linguistici gratuiti (Free Tier) e integrarlo con **Paperclip** utilizzando **TypeScript**.

## 🛠️ Architettura del Sistema

Il flusso dei dati si sviluppa attraverso tre componenti principali:
1. **Paperclip Agent (TypeScript):** Esegue la logica di orchestrazione inviando richieste formattate secondo lo standard OpenAI.
2. **LLM Gateway / Proxy:** Riceve la richiesta, gestisce il pooling delle chiavi, i rate limit e il failover automatico.
3. **Free Tier Provider:** (Gemini, Groq, Cerebras, ecc.) Elabora la richiesta a costo zero.

```
[Paperclip (TS Client)] ──> [LLM Gateway (Porta Locale)] ──> [Provider Free Tier]
```

---

## 📂 Repository GitHub Consigliati per il Gateway

I seguenti progetti permettono di avviare un proxy locale compatibile con OpenAI focalizzato sui tier gratuiti:

| Repository | Tecnologia | Punti di Forza |
| :--- | :--- | :--- |
| **`malda231125/free-llm-gateway`** | TypeScript / NestJS | Perfetto per sviluppatori TS. Supporta Gemini, Groq, Cerebras e GitHub Models. |
| **`0xzr/freellmpool`** | Docker / Go | Ottimo pooling di chiavi e gestione avanzata dei fallimenti con rotte pubbliche. |
| **`tashfeenahmed/freellmapi`** | Python | Supporta oltre 600 modelli e gestisce in trasparenza l'errore `429 Rate Limit`. |

---

## 🔧 Configurazione e Integrazione

### 1. Avvio del Gateway (Esempio concettuale)
Scarica e avvia uno dei proxy sopra indicati (es. tramite Docker o Node) assicurandoti che sia in ascolto localmente. Di norma, l'endpoint esposto sarà:
`http://localhost:4000/v1` (o porte simili a seconda del progetto).

### 2. Configurazione dell'Agente in Paperclip (TypeScript)

Configura il client all'interno del codice del tuo agente puntando al proxy locale. Poiché il gateway emula l'API di OpenAI, puoi riutilizzare l'SDK ufficiale.

```typescript
import { OpenAI } from 'openai';

// Inizializzazione del client Paperclip orientato al Gateway Gratuito
const freeGatewayClient = new OpenAI({
  baseURL: 'http://localhost:4000/v1', // URL del proxy locale
  apiKey: 'free_tier_placeholder_key', // Chiave fittizia (gestita dal proxy)
});

export async function eseguiTaskPaperclip(prompt: string, modelloSpecifico: string = 'gemini-free') {
  try {
    const response = await freeGatewayClient.chat.completions.create({
      model: modelloSpecifico, // Nome del modello mappato nel gateway
      messages: [{ role: 'user', content: prompt }],
    });

    return {
      success: true,
      output: response.choices[0].message.content,
    };
  } catch (error) {
    console.error('Errore durante l\'instradamento sul gateway:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown gateway error',
    };
  }
}
```

---

## 📈 Vantaggi dell'Accoppiata Gateway + Paperclip

* **Costo Zero Effettivo:** Sfrutti la potenza di Paperclip per far girare agenti asincroni in background senza preoccuparti del consumo di token.
* **Resilienza ai Blocchi:** Se un provider free lancia un errore di limite richieste (`HTTP 429`), il gateway devia la richiesta su un altro modello o provider in modo trasparente per Paperclip.
* **Forte Tipizzazione:** Utilizzando TypeScript e l'SDK di OpenAI, mantieni l'autocompletamento e il controllo dei tipi intatto.