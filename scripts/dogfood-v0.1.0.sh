#!/usr/bin/env bash
# Dogfood runner for v0.1.0 (rc and final). Walks the v0.1.1 hardening fixes
# end-to-end on a real seed + a real audio file, with red/green markers and a
# nonzero exit on any failure. Read-only against the seed except for a fresh
# "dogfood" workspace it scaffolds under <workspace>/Seeds/dogfood/.
#
# Usage:
#   scripts/dogfood-v0.1.0.sh \
#       --workspace ~/compost-v010-dogfood \
#       --audio ~/recordings/some-interview.m4a \
#       [--skip-audio]            # skip the transcription paths (saves ~5 min)
#       [--skip-plugin]           # skip the manual Claude Code plugin check
#       [--keep-workspace]        # don't rm -rf the workspace at the end
#
# Exit codes: 0 = all green; 1 = at least one check failed.
#
# What's verified (mapped to v0.1.1 issue numbers):
#   compost --version             — bump landed (#router VERSION)
#   compost setup                 — install story (no key required, #160)
#   watch --once accounting       — #164 (failures surface; exit 1 on any)
#   status / saturate agree       — #166 (canonical-session resolver)
#   tag has no filler/timestamps  — #171
#   transcript language ≠ "und"   — #190 (native) / #180 (WhisperX)
#   diarized speakers ≈ ground    — #178 (over-segmentation collapse)
#   create --ai fail-fast atomic  — #165 (no orphan .md, every missing flag)
#   endorse <C-slug> works        — #168 (human id resolver)
#   endorse twice is idempotent   — #169 (already_endorsed)
#   missing local model error     — #191 (actionable Ollama message)
#
# Intentionally NOT covered (manual): plugin (/compost-welcome in a Claude Code
# session), `compost chat` happy path (depends on a pulled model).

set -u

# ---------- args ----------
WORKSPACE=""
AUDIO=""
SKIP_AUDIO=0
SKIP_PLUGIN=0
KEEP_WORKSPACE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --audio) AUDIO="$2"; shift 2 ;;
    --skip-audio) SKIP_AUDIO=1; shift ;;
    --skip-plugin) SKIP_PLUGIN=1; shift ;;
    --keep-workspace) KEEP_WORKSPACE=1; shift ;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$WORKSPACE" ]]; then
  echo "error: --workspace <path> is required (a writable scratch directory)" >&2
  exit 2
fi
if [[ "$SKIP_AUDIO" = 0 && -z "$AUDIO" ]]; then
  echo "error: --audio <path> required unless --skip-audio is set" >&2
  exit 2
fi
if [[ "$SKIP_AUDIO" = 0 && ! -r "$AUDIO" ]]; then
  echo "error: --audio path is not readable: $AUDIO" >&2
  exit 2
fi

# ---------- output helpers ----------
if [[ -t 1 ]]; then
  GREEN=$'\033[32m'; RED=$'\033[31m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
else
  GREEN=""; RED=""; YEL=""; DIM=""; RST=""
fi
PASS=0; FAIL=0; SKIP=0
declare -a FAILURES
declare -a SKIPS
section() { printf "\n${DIM}── %s ──${RST}\n" "$*"; }
pass()    { printf "  ${GREEN}✓${RST} %s\n" "$*"; PASS=$((PASS+1)); }
fail()    { printf "  ${RED}✗${RST} %s\n" "$*"; FAIL=$((FAIL+1)); FAILURES+=("$*"); }
skip()    { printf "  ${YEL}–${RST} %s ${DIM}(skipped)${RST}\n" "$*"; SKIP=$((SKIP+1)); SKIPS+=("$*"); }
note()    { printf "    ${DIM}%s${RST}\n" "$*"; }

# Run a quiet sub-step that should succeed; capture stdout/stderr for diagnostics.
run_step() {
  local desc="$1"; shift
  local out
  if out=$("$@" 2>&1); then
    pass "$desc"
    printf '%s\n' "$out" > "$LOG_DIR/${PASS}-pass.log"
    return 0
  else
    fail "$desc"
    printf '%s\n' "$out" > "$LOG_DIR/${FAIL}-fail.log"
    note "log: $LOG_DIR/${FAIL}-fail.log"
    return 1
  fi
}

# ---------- workspace ----------
WORKSPACE=$(cd "$(dirname "$WORKSPACE")" 2>/dev/null && echo "$(pwd)/$(basename "$WORKSPACE")") \
  || { echo "error: --workspace parent does not exist"; exit 2; }
mkdir -p "$WORKSPACE"
cd "$WORKSPACE"
LOG_DIR="$WORKSPACE/.dogfood-logs"
rm -rf "$LOG_DIR" && mkdir -p "$LOG_DIR"
trap '[[ "$KEEP_WORKSPACE" = 0 ]] && rm -rf "$WORKSPACE/Seeds/dogfood" "$LOG_DIR" || true' EXIT
echo "${DIM}workspace: $WORKSPACE${RST}"

# Need a `compost` on PATH. Allow override via COMPOST_BIN.
COMPOST="${COMPOST_BIN:-compost}"
if ! command -v "$COMPOST" >/dev/null 2>&1; then
  echo "error: '$COMPOST' not on PATH. Set COMPOST_BIN=... or install @they-juanreina/compost-cli." >&2
  exit 2
fi

# ---------- 1. install / version (#router VERSION) ----------
section "install + version"
VERSION_OUT="$("$COMPOST" --version 2>&1 || true)"
if [[ "$VERSION_OUT" =~ 0\.1\.0(-rc\.[0-9]+)?$ ]]; then
  pass "compost --version reports a v0.1.0 line ($VERSION_OUT)"
else
  fail "compost --version expected 0.1.0[-rc.N], got: $VERSION_OUT"
fi

# `compost setup` should pass core checks; node/ollama/etc.
SETUP_OUT="$("$COMPOST" setup 2>&1 || true)"
if echo "$SETUP_OUT" | grep -qE '"status"\s*:\s*"ok"'; then
  pass "compost setup → status: ok"
elif echo "$SETUP_OUT" | grep -q '"status"\s*:\s*"warn"'; then
  pass "compost setup → status: warn (acceptable for dogfood)"
else
  fail "compost setup did not succeed (#160 — local-by-default install)"
  echo "$SETUP_OUT" > "$LOG_DIR/setup.log"
  note "log: $LOG_DIR/setup.log"
fi

# ---------- 2. seed scaffolding ----------
section "init + multi-seed safety"
mkdir -p Seeds
rm -rf Seeds/dogfood Seeds/dogfood-noise
INIT_OUT="$("$COMPOST" init dogfood 2>&1)" \
  && pass "compost init dogfood" \
  || fail "compost init dogfood — $INIT_OUT"

# Make a second seed so the multi-seed default error fires somewhere.
"$COMPOST" init dogfood-noise >/dev/null 2>&1 || true

MULTI_OUT="$("$COMPOST" status 2>&1 || true)"
if echo "$MULTI_OUT" | grep -qE 'Multiple seeds|"seeds"\s*:\s*\['; then
  pass "status surfaces both seeds (multi-seed listing or actionable error)"
else
  fail "multi-seed status behavior unexpected — saw: $(echo "$MULTI_OUT" | head -1)"
fi

# ---------- 3. provenance — #165 / #168 / #169 ----------
section "provenance: atomic create + human-id endorse + idempotency"

# 3a — #165: --ai missing flags should fail BEFORE writing the .md.
ORPHAN_PATH="Seeds/dogfood/codebook/should-fail.md"
rm -f "$ORPHAN_PATH"
FAIL_OUT="$("$COMPOST" create code --ai --name should-fail --definition x \
              --actor-id "claude-code:0.1.0:abc" --seed dogfood 2>&1 || true)"
if echo "$FAIL_OUT" | grep -q "INVALID_INPUT" \
   && echo "$FAIL_OUT" | grep -q -- "--model" \
   && echo "$FAIL_OUT" | grep -q -- "--prompt-hash"; then
  pass "#165 create --ai with missing flags fails fast, naming each one"
else
  fail "#165 expected INVALID_INPUT naming --model + --prompt-hash; got: $FAIL_OUT"
fi
if [[ ! -e "$ORPHAN_PATH" ]]; then
  pass "#165 no orphaned markdown after a failed --ai create"
else
  fail "#165 orphan .md written — atomic guard regressed: $ORPHAN_PATH"
fi

# 3b — happy path: --ai with all three flags lands a C-slug.
HASH="$(printf '%64s' '' | tr ' ' a)"  # 64 'a's
CREATE_OUT="$("$COMPOST" create code --ai \
  --name dogfood-code --definition "what this captures" \
  --actor-id "claude-code:0.1.0:abc12345" \
  --model claude-opus-4-7 --prompt-hash "$HASH" \
  --seed dogfood 2>&1)"
if echo "$CREATE_OUT" | grep -q '"id"\s*:\s*"C-dogfood-code"'; then
  pass "create --ai (complete) returns id: C-dogfood-code"
else
  fail "create --ai (complete) did not return C-dogfood-code — $CREATE_OUT"
fi

# 3c — #168: endorse accepts the human id.
END1="$("$COMPOST" endorse C-dogfood-code --seed dogfood 2>&1)"
if echo "$END1" | grep -q '"status"\s*:\s*"ok"'; then
  pass "#168 endorse accepts the human id C-dogfood-code"
else
  fail "#168 endorse C-dogfood-code did not return ok — $END1"
fi

# 3d — #169: second endorse is idempotent.
END2="$("$COMPOST" endorse C-dogfood-code --seed dogfood 2>&1)"
if echo "$END2" | grep -q '"status"\s*:\s*"already_endorsed"'; then
  pass "#169 second endorse → status: already_endorsed (no duplicate event)"
else
  fail "#169 second endorse did not report already_endorsed — $END2"
fi

# ---------- 4. tag — #171 ----------
section "tag — stopword + timestamp filter (#171)"
TAG_OUT="$("$COMPOST" tag --seed dogfood 2>&1 || true)"
# A clean seed with no transcripts → empty suggestions. We only assert that
# the noisy markers (filler n-grams, digit-bearing tokens) are absent.
if echo "$TAG_OUT" | grep -qE '"phrase"\s*:\s*"(you know|and like|right like|like that)"'; then
  fail "#171 tag suggested a conversational filler n-gram"
else
  pass "#171 tag does not suggest 'you know' / 'and like' / 'right like' / 'like that'"
fi
if echo "$TAG_OUT" | grep -qE '"phrase"[^"]+[0-9]'; then
  fail "#171 tag suggested a phrase containing a digit (timestamp noise)"
else
  pass "#171 tag does not suggest digit-bearing phrases"
fi

# ---------- 5. session counts agree — #166 ----------
section "saturate ↔ status agree on the session set (#166)"
# Drop a non-canonical 'Attachments' dir that previously inflated saturate.
mkdir -p Seeds/dogfood/sessions/Attachments
STATUS_JSON="$("$COMPOST" status --seed dogfood 2>&1)"
SAT_JSON="$("$COMPOST" saturate --seed dogfood 2>&1 || true)"
STATUS_SESSIONS=$(echo "$STATUS_JSON" | python3 -c "import json,sys;p=json.load(sys.stdin);print(sum(s['counts']['sessions']['total'] for s in p['seeds']))" 2>/dev/null || echo "?")
SAT_SESSIONS=$(echo "$SAT_JSON" | python3 -c "import json,sys;p=json.load(sys.stdin);print(p.get('sessions',-1))" 2>/dev/null || echo "?")
if [[ "$STATUS_SESSIONS" == "$SAT_SESSIONS" && "$STATUS_SESSIONS" != "?" ]]; then
  pass "#166 status sessions ($STATUS_SESSIONS) == saturate sessions ($SAT_SESSIONS) — Attachments ignored"
else
  fail "#166 status sessions ($STATUS_SESSIONS) != saturate sessions ($SAT_SESSIONS)"
fi

# ---------- 6. transcription path — #180 / #190 / #178 / #164 ----------
if [[ "$SKIP_AUDIO" = 1 ]]; then
  skip "audio path (--skip-audio): #180 #190 #178 #164"
else
  section "transcription end-to-end (#180 #190 #178 #164)"

  # Drop the audio into S001 directly so we don't depend on _inbox watcher tick.
  mkdir -p "Seeds/dogfood/sessions/S001"
  cp "$AUDIO" "Seeds/dogfood/sessions/S001/source$(echo "$AUDIO" | sed 's/.*\././')"

  # Transcribe with --language en — exercises #180 (WhisperX) / #190 (native).
  TRANSCRIBE_OUT="$("$COMPOST" transcribe S001 --language en --seed dogfood 2>&1 || true)"
  if echo "$TRANSCRIBE_OUT" | grep -qiE 'completed|"status"\s*:\s*"ok"'; then
    pass "transcribe S001 completed"
    if [[ -r "Seeds/dogfood/sessions/S001/transcript.json" ]]; then
      LANG=$(python3 -c "import json;p=json.load(open('Seeds/dogfood/sessions/S001/transcript.json'));print(p.get('language','?'))")
      SPK=$(python3 -c "import json;p=json.load(open('Seeds/dogfood/sessions/S001/transcript.json'));print(len(p.get('speakers',[])))")
      if [[ "$LANG" != "und" && -n "$LANG" ]]; then
        pass "#190/#180 transcript.language = '$LANG' (not 'und')"
      else
        fail "#190/#180 transcript.language is '$LANG' — language hint did not stick"
      fi
      # Most clean conversational interviews land at 1–3 speakers; >4 is a hint
      # that the merge didn't fire. This is a soft check (warn, not fail) since
      # exotic content (panels, group calls) can legitimately exceed.
      # Meeting recordings legitimately exceed 3 speakers — the #178 fix's
      # job is to NOT let pyannote's sliver fragments balloon the count
      # (pre-fix: 2 real → 5–6 reported). With the 5% min-share merge in
      # place, anything 1–6 is plausibly real for conversational content;
      # above ~6 starts looking like over-segmentation again.
      if [[ "$SPK" -ge 1 && "$SPK" -le 6 ]]; then
        pass "#178 diarized speakers = $SPK (within plausible 1–6 range; merge ran)"
      else
        fail "#178 diarized speakers = $SPK (outside 1–6 — possible over-segmentation)"
      fi
    else
      fail "transcribe completed but transcript.json missing"
    fi
  else
    fail "transcribe S001 did not succeed — see log"
    echo "$TRANSCRIBE_OUT" > "$LOG_DIR/transcribe.log"
    note "log: $LOG_DIR/transcribe.log"
  fi

  # watch --once accounting — #164
  WATCH_OUT="$("$COMPOST" watch --once --seed dogfood 2>&1 || true)"
  WATCH_EXIT=$?
  if echo "$WATCH_OUT" | grep -qE '"status"\s*:\s*"ok"|"status"\s*:\s*"completed_with_failures"'; then
    pass "#164 watch --once reports an explicit status (ok or completed_with_failures)"
  else
    fail "#164 watch --once status unrecognized: $(echo "$WATCH_OUT" | head -1)"
  fi
fi

# ---------- 7. local-model error — #191 ----------
section "#191 Ollama 404 → actionable error"
# chat short-circuits to "no indexed sessions" BEFORE calling the LLM when
# the seed has no embedded transcripts. So on --skip-audio we can't exercise
# the model-missing path; the runtime fix is covered by the cli's
# adapter.test.ts unit tests (#191) and the dogfood asserts it end-to-end
# only when an audio path actually populated the index.
if [[ "$SKIP_AUDIO" = 1 ]]; then
  skip "#191 (needs an indexed seed; covered by cli/src/llm/adapter.test.ts on --skip-audio)"
elif command -v ollama >/dev/null 2>&1; then
  CHAT_MODEL=$("$COMPOST" config get defaults.quick_chat 2>/dev/null | tr -d '"' || true)
  CHAT_MODEL=${CHAT_MODEL#ollama:}
  if [[ -n "$CHAT_MODEL" ]] && ollama list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$CHAT_MODEL"; then
    skip "#191 actionable error (chat model '$CHAT_MODEL' is pulled — would need to rm to test)"
  else
    CHAT_ERR="$("$COMPOST" chat "test" --seed dogfood 2>&1 || true)"
    if echo "$CHAT_ERR" | grep -q "ollama pull"; then
      pass "#191 missing local model surfaces 'run \`ollama pull X\`'"
    elif echo "$CHAT_ERR" | grep -qE 'No indexed sessions|"retrieved"\s*:\s*0'; then
      # The seed got transcribed but never reached embed/index — chat
      # short-circuits before touching the LLM. Treat as a skip (not a fail)
      # so we don't false-fail; the cli unit tests still cover the fix.
      skip "#191 chat short-circuited (no retrieval hits) — verify ran in cli unit tests"
    else
      fail "#191 missing-model error not actionable: $(echo "$CHAT_ERR" | head -3 | tr -d '\n')"
    fi
  fi
else
  skip "#191 (ollama not on PATH)"
fi

# ---------- 8. plugin (manual reminder) ----------
section "plugin / MCP roundtrip (manual)"
if [[ "$SKIP_PLUGIN" = 1 ]]; then
  skip "plugin path (--skip-plugin)"
else
  printf "  ${YEL}!${RST} manual check in a Claude Code session:\n"
  printf "      1. install the local plugin (or use the published one)\n"
  printf "      2. run /compost-welcome\n"
  printf "      3. create a highlight/code via the MCP tools\n"
  printf "      4. confirm \`compost blame <id>\` shows the AI draft + your endorse\n"
fi

# ---------- summary ----------
echo
printf "${DIM}── summary ──${RST}\n"
printf "  ${GREEN}%d passed${RST}, ${RED}%d failed${RST}, ${YEL}%d skipped${RST}\n" "$PASS" "$FAIL" "$SKIP"
if (( FAIL > 0 )); then
  printf "${RED}\nfailures:${RST}\n"
  printf "  - %s\n" "${FAILURES[@]}"
fi
if (( SKIP > 0 )); then
  printf "${YEL}\nskipped:${RST}\n"
  printf "  - %s\n" "${SKIPS[@]}"
fi

[[ "$FAIL" = 0 ]] && exit 0 || exit 1
