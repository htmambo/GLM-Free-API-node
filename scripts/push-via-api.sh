#!/usr/bin/env bash
# Push the local main commit to GitHub through the REST API.
#
# The git transport to github.com is unreliable from this network (HTTP2
# framing errors / hangs), so the commit is rebuilt through the API:
#   1. create a blob per changed file
#   2. create a tree that points at those blobs
#   3. create a commit on top of the remote head
#   4. move refs/heads/main to the new commit
#
# Usage: ./scripts/push-via-api.sh
set -euo pipefail

REPO="htmambo/GLM-Free-API-node"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="https://api.github.com"

RAW=$(security find-generic-password -s "gh:github.com" -w)
TOKEN=$(printf '%s' "${RAW#go-keyring-base64:}" | base64 -d)

cd "$ROOT"

# Files that differ between the remote head and the working tree.
BASE=$(curl -sS -m 30 "$API/repos/$REPO/git/refs/heads/main" \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).object.sha))")

echo "remote head: $BASE"

# Build the file list: everything the local commit(s) touch, taken from git.
FILES=$(git diff --name-only "$BASE" HEAD -- . || true)
if [ -z "$FILES" ]; then
  echo "nothing to push — local tree matches the remote head"
  exit 0
fi
echo "files to push:"
echo "$FILES" | sed 's/^/  /'

api() { # api <method> <path> [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -m 60 -X "$method" "$API$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "Content-Type: application/json" \
      -d "$body"
  else
    curl -sS -m 60 -X "$method" "$API$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json"
  fi
}

json_field() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s)$1??'')}catch{console.log('')}})"; }

# --- 1. blobs -------------------------------------------------------------
ENTRIES=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if git cat-file -e "$BASE:$f" 2>/dev/null; then MODE="100644"; else MODE="100644"; fi
  SHA=$(node -e '
    const b=require("fs").readFileSync(process.argv[1]).toString("base64");
    process.stdout.write(JSON.stringify({content:b,encoding:"base64"}));
  ' "$f" | curl -sS -m 60 -X POST "$API/repos/$REPO/git/blobs" \
      -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
      -H "Content-Type: application/json" \
      --data-binary @- | json_field ".sha")
  if [ -z "$SHA" ]; then echo "blob upload failed for $f" >&2; exit 1; fi
  echo "  blob $f -> ${SHA:0:8}"
  ENTRIES="$ENTRIES{\"path\":$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$f"),\"mode\":\"$MODE\",\"type\":\"blob\",\"sha\":\"$SHA\"},"
done <<< "$FILES"
ENTRIES="${ENTRIES%,}"

# --- 2. tree --------------------------------------------------------------
TREE=$(api POST "/repos/$REPO/git/trees" "{\"base_tree\":\"$BASE\",\"tree\":[$ENTRIES]}" | json_field ".sha")
if [ -z "$TREE" ]; then echo "tree creation failed" >&2; exit 1; fi
echo "tree: $TREE"

# --- 3. commit ------------------------------------------------------------
MSG=$(git log -1 --pretty=%B HEAD)
BODY=$(node -e '
  const msg=process.argv[1];
  process.stdout.write(JSON.stringify({message:msg,tree:process.argv[2],parents:[process.argv[3]]}));
' "$MSG" "$TREE" "$BASE")
COMMIT=$(api POST "/repos/$REPO/git/commits" "$BODY" | json_field ".sha")
if [ -z "$COMMIT" ]; then echo "commit creation failed" >&2; exit 1; fi
echo "commit: $COMMIT"

# --- 4. update the ref ----------------------------------------------------
UPD=$(api PATCH "/repos/$REPO/git/refs/heads/main" "{\"sha\":\"$COMMIT\",\"force\":false}" | json_field ".object.sha")
echo "new main: $UPD"
[ "$UPD" = "$COMMIT" ] || { echo "ref update failed" >&2; exit 1; }
echo "pushed $COMMIT to origin/$REPO"
