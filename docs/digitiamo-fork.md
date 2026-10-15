# Fork Digitiamo — Paperclip

Guida operativa per mantenere il fork Digitiamo allineabile all’upstream ufficiale senza perdere le modifiche locali.

## Repository

| Ruolo | URL |
|--------|-----|
| Fork Digitiamo (`origin`) | `git@digitiamo.github.com:digitiamo-agency/paperclip.git` |
| Upstream ufficiale (`upstream`) | `https://github.com/paperclipai/paperclip.git` |

- **Branch di default:** `master` (non `main`)
- **Checkout locale tipico:** `/Users/massimiliano.andreatta/PROJECTS/PAPERCLIP`

## Remoti Git

```bash
# Verifica
git remote -v

# Setup (già fatto sul clone Digitiamo)
git remote add upstream https://github.com/paperclipai/paperclip.git
git fetch upstream
```

Atteso:

```
origin    git@digitiamo.github.com:digitiamo-agency/paperclip.git (fetch/push)
upstream  https://github.com/paperclipai/paperclip.git (fetch/push)
```

`upstream` si usa solo per leggere/allineare; i push delle feature Digitiamo vanno su `origin`.

## Modello di lavoro

1. Tieni `master` del fork allineabile a `upstream/master` (merge periodici).
2. Sviluppa le feature Digitiamo su **branch dedicati** (`feature/...`, `fix/...`, …).
3. Apri PR verso il fork Digitiamo (`origin`), non verso paperclipai (salvo contributo volontario upstream).
4. Dopo ogni sync di `master`, aggiorna i branch feature con `git merge master` (o rebase se il team lo decide).

### Perché merge (non rebase) su `master`

Su un fork condiviso il **merge** da upstream preserva la storia e evita rewrite che costringerebbero force-push. Il rebase va usato solo su branch privati non ancora condivisi.

## Script di allineamento

File: [`scripts/sync-upstream.sh`](../scripts/sync-upstream.sh)

**Policy Digitiamo consigliata:** porting **selettivo** (cherry-pick / ADAPT), non merge cieco di tutto upstream. Usa la skill AI prima del merge totale.

```bash
# Triage AI (consigliato): raccoglie delta + hint per la skill
./scripts/sync-upstream.sh --advise

# Solo preview commit (senza report strutturato)
./scripts/sync-upstream.sh --dry-run

# Merge totale upstream → branch corrente (working tree pulito)
# Usare solo dopo triage e conferma esplicita
./scripts/sync-upstream.sh

# Merge + push su origin
./scripts/sync-upstream.sh --push

# Target esplicito
./scripts/sync-upstream.sh --branch master --push
```

### Skill AI: evaluate-upstream-sync

Path: [`.agents/skills/evaluate-upstream-sync/`](../.agents/skills/evaluate-upstream-sync/)

1. Esegui `./scripts/sync-upstream.sh --advise` (o lo script gather della skill).
2. In una chat Agent Cursor: applica la skill `evaluate-upstream-sync`.
3. Ottieni un report italiano con bucket **TAKE / ADAPT / SKIP / DEFER**.
4. Solo dopo conferma: cherry-pick / porting mirato (la skill non fa merge da sola).

Manifest superfici Digitiamo: [`references/digitiamo-surfaces.md`](../.agents/skills/evaluate-upstream-sync/references/digitiamo-surfaces.md) — aggiornalo quando aggiungi custom di lunga durata.

### Opzioni

| Flag | Effetto |
|------|---------|
| `--advise` | Fetch + report strutturato per triage selettivo; nessun merge |
| `--dry-run` | Fetch + lista commit; nessun merge |
| `--push` | Dopo merge ok, `git push origin <branch>` |
| `--branch BR` | Branch locale da aggiornare (default: corrente) |
| `--upstream-branch BR` | Branch upstream (default: auto `master` o `main`) |
| `--no-ff` | Forza merge commit anche se fast-forward |
| `-h` / `--help` | Aiuto |

### Comportamento

1. Controlla che esistano `origin` e `upstream`.
2. Rifiuta se il working tree è sporco (tranne in `--dry-run`).
3. `git fetch origin` + `git fetch upstream --tags`.
4. Confronta locale vs `upstream/<branch>` e stampa quanti commit sei dietro/avanti.
5. Esegue `git merge upstream/<branch>`.
6. In caso di conflitti: lascia i marker; risolvi, `git add`, `git commit`, poi push.

### Conflitti tipici

```bash
# dopo fallimento dello script
git status
# edita i file in conflitto
git add <file...>
git commit
git push origin master
```

## Flusso feature Digitiamo

```bash
git checkout master
./scripts/sync-upstream.sh --push   # opzionale, se vuoi master aggiornato

git checkout -b feature/mia-feature
# ... commit locali ...
git push -u origin feature/mia-feature
# apri PR su digitiamo-agency/paperclip
```

Dopo un sync di `master`:

```bash
git checkout feature/mia-feature
git merge master
# risolvi conflitti se presenti, poi push
```

## Buone pratiche anti-conflitto

- Isola custom Digitiamo (branding, integrazioni, config) in file/cartelle poco toccati da upstream.
- Evita riscritture ampie del core senza necessità.
- Allinea spesso (settimanale o a ogni release/tag upstream), non dopo mesi di divergenza.
- Prima di portare cambiamenti: `--advise` + skill `evaluate-upstream-sync`; evita merge totali “a sorpresa”.
- Aggiorna `digitiamo-surfaces.md` quando una custom diventa permanente.

## Clone da zero

```bash
git clone git@digitiamo.github.com:digitiamo-agency/paperclip.git
cd paperclip
git remote add upstream https://github.com/paperclipai/paperclip.git
git fetch upstream
./scripts/sync-upstream.sh --dry-run
```

## Nota HERCULES

Se HERCULES consuma Paperclip come submodule/dependency, dopo che il fork Digitiamo è la fonte ufficiale va aggiornato il puntamento da `paperclipai/paperclip` a `digitiamo-agency/paperclip` (e lo SHA corrispondente). Quello è un passo separato dal sync di questo repo.

## Documentazione Digitiamo correlata

- Esecuzione locale: [`docs/digitiamo-local.md`](./digitiamo-local.md)

## Riferimenti rapidi

| Cosa | Dove |
|------|------|
| Script sync | `scripts/sync-upstream.sh` |
| Questo documento | `docs/digitiamo-fork.md` |
| Upstream | https://github.com/paperclipai/paperclip |
| Fork | digitiamo-agency/paperclip (host SSH `digitiamo.github.com`) |
