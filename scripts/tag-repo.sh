#!/usr/bin/env bash
# Mark the GitHub repository so Magpie's Discover finds it.
# Usage: scripts/tag-repo.sh [owner/repo]
set -euo pipefail

repo="${1:-$(git remote get-url origin 2>/dev/null | sed -E 's#^(git@github.com:|https://github.com/)##; s#\.git$##')}"
if [[ -z "${repo}" ]]; then
  echo "usage: $0 owner/repo" >&2
  exit 1
fi

gh repo edit "${repo}" \
  --add-topic magpie-plugin \
  --add-topic magpie \
  --add-topic workbuddy \
  --add-topic workbuddy-ai
echo "topics set on ${repo}: magpie-plugin, magpie, workbuddy, workbuddy-ai"
