#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
printf '#!/usr/bin/env bash\nexec bash scripts/public-guard.sh\n' > .git/hooks/pre-push
chmod +x .git/hooks/pre-push scripts/public-guard.sh
echo "pre-push guard installed"
