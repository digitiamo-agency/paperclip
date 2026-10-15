#!/usr/bin/env bash
# Allinea il fork Digitiamo all'upstream ufficiale Paperclip (merge).
#
# Uso:
#   ./scripts/sync-upstream.sh              # fetch + merge su branch corrente (o --branch)
#   ./scripts/sync-upstream.sh --dry-run    # mostra solo cosa arriverà
#   ./scripts/sync-upstream.sh --advise     # report strutturato per skill evaluate-upstream-sync (no merge)
#   ./scripts/sync-upstream.sh --push       # dopo il merge, push su origin
#   ./scripts/sync-upstream.sh --branch master
#
# Remoti attesi:
#   origin   -> git@digitiamo.github.com:digitiamo-agency/paperclip.git
#   upstream -> https://github.com/paperclipai/paperclip.git
#
# Opzioni:
#   --dry-run     Non modifica nulla; stampa commit in arrivo/uscita
#   --advise      Non modifica nulla; raccoglie delta per triage selettivo (skill AI)
#   --push        Push del branch locale su origin dopo merge riuscito
#   --branch BR   Branch locale da aggiornare (default: branch corrente)
#   --upstream-branch BR  Branch upstream (default: auto master|main)
#   --no-ff       Forza merge commit anche se fast-forward possibile
#   -h, --help    Mostra aiuto
#
# Nota: per porting selettivo (consigliato sul fork Digitiamo) usa --advise e la
# skill .agents/skills/evaluate-upstream-sync — non il merge totale di default.

set -euo pipefail

DRY_RUN=0
ADVISE=0
DO_PUSH=0
NO_FF=0
LOCAL_BRANCH=""
UPSTREAM_BRANCH=""

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --advise) ADVISE=1; shift ;;
    --push) DO_PUSH=1; shift ;;
    --no-ff) NO_FF=1; shift ;;
    --branch)
      [[ $# -ge 2 ]] || die "--branch richiede un nome"
      LOCAL_BRANCH="$2"
      shift 2
      ;;
    --upstream-branch)
      [[ $# -ge 2 ]] || die "--upstream-branch richiede un nome"
      UPSTREAM_BRANCH="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "opzione sconosciuta: $1 (usa --help)"
      ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "non sei in un repository git"
cd "$ROOT"

if [[ "$ADVISE" -eq 1 ]]; then
  GATHER="$ROOT/.agents/skills/evaluate-upstream-sync/scripts/gather-upstream-delta.sh"
  [[ -x "$GATHER" || -f "$GATHER" ]] || die "manca gather script: $GATHER"
  echo "==> Modalità --advise (nessun merge). Skill: evaluate-upstream-sync"
  echo ""
  if [[ -n "$LOCAL_BRANCH" && -n "$UPSTREAM_BRANCH" ]]; then
    bash "$GATHER" --branch "$LOCAL_BRANCH" --upstream-branch "$UPSTREAM_BRANCH"
  elif [[ -n "$LOCAL_BRANCH" ]]; then
    bash "$GATHER" --branch "$LOCAL_BRANCH"
  elif [[ -n "$UPSTREAM_BRANCH" ]]; then
    bash "$GATHER" --upstream-branch "$UPSTREAM_BRANCH"
  else
    bash "$GATHER"
  fi
  echo ""
  echo "Prossimo passo: apri una chat Agent e chiedi di applicare la skill"
  echo "evaluate-upstream-sync sul report sopra (policy: TAKE/ADAPT/SKIP/DEFER)."
  exit 0
fi

git remote get-url origin >/dev/null 2>&1 || die "remote 'origin' mancante"
git remote get-url upstream >/dev/null 2>&1 || die "remote 'upstream' mancante — esegui: git remote add upstream https://github.com/paperclipai/paperclip.git"

if [[ -z "$LOCAL_BRANCH" ]]; then
  LOCAL_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
fi
[[ "$LOCAL_BRANCH" != "HEAD" ]] || die "detached HEAD: specifica --branch"

if [[ -n "$(git status --porcelain)" ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "Avviso: working tree sporco (ok in --dry-run)." >&2
  else
    die "working tree sporco: committa o stash prima di allineare"
  fi
fi

echo "==> Fetch origin + upstream"
git fetch origin
git fetch upstream --tags

detect_upstream_branch() {
  if git rev-parse --verify --quiet "upstream/master" >/dev/null; then
    echo "master"
  elif git rev-parse --verify --quiet "upstream/main" >/dev/null; then
    echo "main"
  else
    die "né upstream/master né upstream/main trovati"
  fi
}

if [[ -z "$UPSTREAM_BRANCH" ]]; then
  UPSTREAM_BRANCH="$(detect_upstream_branch)"
fi

UPSTREAM_REF="upstream/${UPSTREAM_BRANCH}"
git rev-parse --verify --quiet "$UPSTREAM_REF" >/dev/null \
  || die "ref assente: $UPSTREAM_REF"

# Assicura di essere sul branch target (creandolo da origin se serve)
if git show-ref --verify --quiet "refs/heads/${LOCAL_BRANCH}"; then
  git checkout "$LOCAL_BRANCH"
elif git show-ref --verify --quiet "refs/remotes/origin/${LOCAL_BRANCH}"; then
  git checkout -b "$LOCAL_BRANCH" "origin/${LOCAL_BRANCH}"
else
  die "branch locale/remoto assente: ${LOCAL_BRANCH}"
fi

LOCAL_SHA="$(git rev-parse HEAD)"
UPSTREAM_SHA="$(git rev-parse "$UPSTREAM_REF")"
BEHIND="$(git rev-list --count "${LOCAL_SHA}..${UPSTREAM_SHA}")"
AHEAD="$(git rev-list --count "${UPSTREAM_SHA}..${LOCAL_SHA}")"

echo ""
echo "Branch locale : ${LOCAL_BRANCH} (${LOCAL_SHA:0:9})"
echo "Upstream      : ${UPSTREAM_REF} (${UPSTREAM_SHA:0:9})"
echo "Commit dietro : ${BEHIND} (upstream → locale)"
echo "Commit avanti : ${AHEAD} (locale → upstream, vostre modifiche)"
echo ""

if [[ "$BEHIND" -eq 0 ]]; then
  echo "Già allineato a ${UPSTREAM_REF}."
  if [[ "$DO_PUSH" -eq 1 && "$DRY_RUN" -eq 0 ]]; then
    git push origin "$LOCAL_BRANCH"
    echo "Push origin/${LOCAL_BRANCH} ok."
  fi
  exit 0
fi

echo "Commit in arrivo da upstream (max 30):"
git --no-pager log --oneline --no-decorate -30 "${LOCAL_SHA}..${UPSTREAM_SHA}"
if [[ "$BEHIND" -gt 30 ]]; then
  echo "... e altri $((BEHIND - 30)) commit"
fi
echo ""

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] Nessuna modifica. Rilancia senza --dry-run per fare il merge."
  exit 0
fi

MERGE_ARGS=(-m "chore(fork): merge ${UPSTREAM_REF} into ${LOCAL_BRANCH}")
if [[ "$NO_FF" -eq 1 ]]; then
  MERGE_ARGS=(--no-ff "${MERGE_ARGS[@]}")
fi

echo "==> Merge ${UPSTREAM_REF} → ${LOCAL_BRANCH}"
if ! git merge "$UPSTREAM_REF" "${MERGE_ARGS[@]}"; then
  cat <<'EOF' >&2

Merge con conflitti. Risolvi i file in conflitto, poi:

  git add <file...>
  git commit
  # opzionale:
  git push origin HEAD

EOF
  exit 1
fi

echo ""
echo "Merge completato."
if [[ "$DO_PUSH" -eq 1 ]]; then
  echo "==> Push origin/${LOCAL_BRANCH}"
  git push origin "$LOCAL_BRANCH"
  echo "Push ok."
else
  echo "Push non eseguito. Quando pronto: git push origin ${LOCAL_BRANCH}"
  echo "Oppure: ./scripts/sync-upstream.sh --push"
fi
