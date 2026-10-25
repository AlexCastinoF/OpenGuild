"""Atualiza SteamFarm Comunidade na VPS (MODE=update)."""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("WM_DEPLOY_MODE", "update")
os.environ.setdefault("SF_DEPLOY_MODE", "update")
os.environ.setdefault("WM_DEPLOY_APP_PORT", "keep")
os.environ.setdefault("SF_DEPLOY_APP_PORT", "keep")
# Update: preservar schema Flask/Zapo no Postgres compartilhado (sem prisma db push)
os.environ.setdefault("SF_REUSE_STEAMFARM_DB", "1")
os.environ.setdefault("SF_REUSE_LIVEKIT", "1")

from install_vps import main  # noqa: E402

raise SystemExit(main())
