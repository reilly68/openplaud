# OpenPlaud — fork (reilly68) na mernas.local

Toto je **fork** `reilly68/openplaud` nasazený self-hosted na mernas.local. Pro
obecné konvence kódu (Next.js 16, Drizzle, Bun, better-auth, struktura) viz
upstream **`AGENTS.md`** v rootu. Tento soubor dokumentuje jen to, co je
**specifické pro fork a nasazení**, a provozní runbook.

## Co to je

- Fork upstreamu `openplaud/openplaud`. Remotes: `origin` = reilly68 (náš), `upstream` = openplaud.
- Běží na `main`, **desítky commitů před upstreamem** (fork-specific featury + fixy).
- Image: `ghcr.io/reilly68/openplaud:dev` (NE `:latest`). Build přes GitHub Actions (Docker workflow) na push do `main`.
- Workflow s upstreamem: `git fetch upstream && git merge upstream/main` → řešit konflikty → push. Nikdy nepushujeme fork→upstream (jen merge upstream→fork).

## Nasazení (mernas.local)

- Kontejnery: `openplaud` (app, port 3010→3000) + `openplaud-db` (postgres:16).
- Compose soubory (root-owned, OMV-generované): `BASE=/srv/dev-disk-by-uuid-6f606104-f83e-48dd-8f60-b4a449dede4c/usbdisk_/openplaud/` → `openplaud.yml` + `compose.override.yml` + `openplaud.env`. **Vždy všechny tři** (override nese HOSTNAME=0.0.0.0 a LOCAL_STORAGE_PATH).
- Reverse proxy: nginx `plaud.mernas.local` → 127.0.0.1:3010 (`/etc/nginx/conf.d/mernas-vhosts.conf`).
- `/plaud-upload` nginx endpoint: přijímá API key (Bearer), injektuje session cookie → `/api/recordings/upload` (pro iPhone Shortcut upload bez session).

### Externí závislost: pascal.local (macOS, MLX)
- **Transkripce:** `http://pascal.local:8092/v1`, model `whisper-large-v3`, posíláme `cleanup:"true"` → server tam dělá LLM cleanup průchod. (Config v DB `api_credentials`, `is_default_transcription=t`.)
- **LLM (summary/title):** `http://pascal.local:8090/v1`, alias `qwen-nothink`.
- Whisper cleanup kdysi vkládal meta-preamble do přepisu — opraveno na pascalu (`server.py`) i obranně zde (viz níže).

## Build & deploy runbook

```bash
# 1. commit na main, push (POZOR: gh default repo je špatně → vždy -R reilly68/openplaud)
git push origin main
# 2. sledovat CI + Docker (Docker ~17-19 min, ARM64 QEMU)
gh run watch <id> -R reilly68/openplaud --exit-status
# 3. po úspěšném Docker buildu nasadit
docker pull ghcr.io/reilly68/openplaud:dev
sudo docker compose -f $BASE/openplaud.yml -f $BASE/compose.override.yml --env-file $BASE/openplaud.env up -d
# 4. health
until curl -sf -o /dev/null http://127.0.0.1:3010/; do sleep 3; done
# 5. QA (subagent) → fix-forward iterace
```
- **Revert pojistka:** před deployem `docker tag <starý-image-id> ghcr.io/reilly68/openplaud:pre-<feature>`. Revert = re-tag na `:dev` + compose up. Funkční kotvy: `pre-edit-backup`, `pre-transcript-edit`.
- Docker build občas spadne na ghcr.io login timeout → `gh run rerun <id> --failed`.

## Fork-specific změny

- **Edit metadat nahrávky** — `PATCH /api/recordings/[id]` (`filename`, `startTime`); dialog `edit-recording-dialog.tsx`; optimistický override v `workstation.tsx`.
- **Edit transkriptu** — `PATCH /api/recordings/[id]/transcript` (`text`, šifruje, `transcriptionType="manual"`, FOR UPDATE lock); dialog `edit-transcription-dialog.tsx`; auto-regenerace summary po uložení; Whisper Re-transcribe varuje když je transkript ručně editovaný.
- **Cleanup-artifact strip** — `stripCleanupArtifacts()` v `src/lib/transcription/format.ts`, v `parseTranscriptionResponse` (choke point). Odstavcový, NE `***`-bridging. Test `src/tests/regressions/cleanup-artifact-strip.test.ts`.
- **generate-title** — `POST /api/recordings/[id]/generate-title` (české titulky, max_tokens 8000 pro qwen thinking).
- **Compose override** HOSTNAME=0.0.0.0 (jinak Next.js bindoval container IP → ECONNREFUSED), Bun.sql global v autoprocess, RIFF magic-byte contentType fix.

## Konvence a záludnosti

- **Šifrování at-rest:** `filename`, `transcriptions.text`, summary jsou šifrované (`encryptText`/`decryptText` z `src/lib/encryption/fields.ts`, formát `v1:iv:tag:ct`). DB drží ciphertext, API vrací plaintext. Při novém endpointu na content poli VŽDY encrypt/decrypt.
- **API route vzor:** `apiHandler` + `requireApiSession`; WHERE scopovat `eq(userId)` + `isNull(deletedAt)`. Vzor: `src/app/api/settings/webhooks/[id]/route.ts`.
- **`TranscriptionPanel` má DVA konzumenty** — `dashboard/workstation-detail-pane.tsx` A `recordings/recording-workstation.tsx`. Nový povinný prop musí dostat oba. **CI „Type Check" job to NEZACHYTÍ — chytne až `next build`.** Vždy `grep -rln "<TranscriptionPanel"`.
- **Biome** je striktní na formát i lint (`Number.isNaN`, line width, import sort). Lokálně na mernas Biome binary segfaultuje (arm stub) a `node_modules` je nekompletní → **lokální lint/typecheck/build NEJDE**, spoléhej na CI a iteruj. Bun na mernas není.
- **OMV přepisuje** `/etc/docker/daemon.json` a compose soubory při aplikaci konfigurace — neměň je ručně bez vědomí, že je OMV může přegenerovat.
- Auto-summary po editaci transkriptu je **client-side** (panel `onSaved` → `handleSummarize`), ne v PATCH endpointu.

## Další kontext

- Detailní historie změn a lessons v paměti Claude Code: `project_openplaud_update.md`.
- Upstream konvence: `AGENTS.md`.
