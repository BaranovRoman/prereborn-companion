# Runtime media hosting

Heavy optimized runtime media is served independently from application
deployments. The web build uses `NEXT_PUBLIC_MEDIA_BASE_URL`; production sets it
to `https://prereborn.ru/media`.

## Server layout

The nginx `/media/` location maps to:

```text
/var/www/www-root/data/media/prereborn/
+-- dota/
    +-- heroes/
    +-- heroes-favorite/
    +-- heroes-featured/
```

The upload contains exactly 381 source files:

| Source pattern | Target path relative to media root | Public URL pattern | Count |
| --- | --- | --- | ---: |
| `apps/web/public/vendor/valve/video/heroes/*.webm` | `dota/heroes/*.webm` | `https://prereborn.ru/media/dota/heroes/*.webm` | 127 |
| `apps/web/public/vendor/valve/video/heroes-favorite/*.webm` | `dota/heroes-favorite/*.webm` | `https://prereborn.ru/media/dota/heroes-favorite/*.webm` | 127 |
| `apps/web/public/vendor/valve/video/heroes-featured/*.webm` | `dota/heroes-featured/*.webm` | `https://prereborn.ru/media/dota/heroes-featured/*.webm` | 127 |

The TSV manifest is the authoritative exact per-file list, including byte sizes
and SHA-256 digests. All three directories contain the optimized runtime variants
used by the web application. Files below this location use `Cache-Control: public,
max-age=31536000, immutable`. A filename must therefore never be reused for
different content. Publish changed content under a new filename or versioned
directory and update the application reference in the same release.

## Manual initial upload for WK-67

From the repository root, create the remote directory and upload the exact
manifested source set:

```bash
export MEDIA_BASE_URL=https://prereborn.ru/media
export MEDIA_SERVER_ROOT=/var/www/www-root/data/media/prereborn

ssh -p "$PRODUCTION_SSH_PORT" "$PRODUCTION_SSH_USER@$PRODUCTION_SSH_HOST" \
  "mkdir -p '$MEDIA_SERVER_ROOT/dota'"

rsync -av --checksum \
  -e "ssh -p $PRODUCTION_SSH_PORT" \
  apps/web/public/vendor/valve/video/ \
  "$PRODUCTION_SSH_USER@$PRODUCTION_SSH_HOST:$MEDIA_SERVER_ROOT/dota/"
```

Do not use `--delete` for the initial manual upload. Apply/reload
`nginx.production.conf`, then validate every expected URL and checksum against
`docs/media/WK-67-media-manifest.tsv` before removing repository media or
changing LFS tracking.

Regenerate the exact manifest while the source files are present:

```bash
node scripts/generate-media-hosting-manifest.mjs
```

The source files were removed from the current repository tree only after all
381 public URLs had been verified. The ignored source directory can be restored
locally when preparing a future media update; regenerate the manifest before
uploading it. Git history was not rewritten and historical LFS cleanup remains a
separate, explicitly destructive decision.
