```python
"""
db/seeddata.py — Seed Data IGNIS (dev/bootstrap)

But :
- Insérer des données de base en DB (idempotent) :
  • Assets (watchlist / catalogue)
  • Telegram chats (configs)
  • (optionnel) price alerts de démonstration

Usage (dev) :
    python -m app.db.seeddata
ou
    python app/db/seeddata.py

ENV utiles :
- IGNIS_SEED_ASSETS=true|false
- IGNIS_SEED_TELEGRAM_CHATS=true|false
- IGNIS_SEED_PRICE_ALERTS=false|true

- IGNIS_SEED_TELEGRAM_CHAT_IDS="-100xxx,12345"
- IGNIS_SEED_TELEGRAM_MIN_PRIORITY="MEDIUM"

Notes :
- Idempotent : si l’enregistrement existe (PK), on update les champs.
- Pour charger une grosse liste d’assets, tu peux remplacer DEFAULT_ASSETS par un load JSON.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

import structlog
from sqlalchemy import select

from app.db.database import AsyncSessionLocal, init_db
from app.db.models import Asset, TelegramChat, PriceAlert

log = structlog.get_logger(__name__)


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _env_bool(name: str, default: bool = False) -> bool:
    v = os.getenv(name, "")
    if v == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "y", "on")


def _env_str(name: str, default: str = "") -> str:
    v = os.getenv(name, "")
    return v.strip() if v.strip() else default


def _env_list(name: str) -> list[str]:
    v = os.getenv(name, "").strip()
    if not v:
        return []
    return [x.strip() for x in v.split(",") if x.strip()]


# ─────────────────────────────────────────────────────────────────────────────
# Defaults (tu peux adapter à ta watchlist)
# ─────────────────────────────────────────────────────────────────────────────

DEFAULT_ASSETS: list[dict[str, Any]] = [
    # CRYPTO (Binance)
    {"symbol": "BTCUSDT", "asset_class": "CRYPTO", "name": "Bitcoin", "exchange": "BINANCE"},
    {"symbol": "ETHUSDT", "asset_class": "CRYPTO", "name": "Ethereum", "exchange": "BINANCE"},
    {"symbol": "SOLUSDT", "asset_class": "CRYPTO", "name": "Solana", "exchange": "BINANCE"},
    {"symbol": "BNBUSDT", "asset_class": "CRYPTO", "name": "BNB", "exchange": "BINANCE"},
    {"symbol": "XRPUSDT", "asset_class": "CRYPTO", "name": "XRP", "exchange": "BINANCE"},

    # FOREX (Yahoo)
    {"symbol": "EURUSD", "asset_class": "FOREX", "name": "EUR/USD", "exchange": "YAHOO"},
    {"symbol": "GBPUSD", "asset_class": "FOREX", "name": "GBP/USD", "exchange": "YAHOO"},
    {"symbol": "USDJPY", "asset_class": "FOREX", "name": "USD/JPY", "exchange": "YAHOO"},

    # INDICES / STOCKS (Yahoo)
    {"symbol": "^GSPC", "asset_class": "INDICES", "name": "S&P 500", "exchange": "YAHOO"},
    {"symbol": "AAPL", "asset_class": "STOCKS", "name": "Apple", "exchange": "YAHOO"},
    {"symbol": "MSFT", "asset_class": "STOCKS", "name": "Microsoft", "exchange": "YAHOO"},
]


# ─────────────────────────────────────────────────────────────────────────────
# Seed engine
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class SeedConfig:
    seed_assets: bool = True
    seed_telegram_chats: bool = True
    seed_price_alerts: bool = False


class SeedData:
    """
    Seed runner idempotent.
    """

    def __init__(self, config: Optional[SeedConfig] = None) -> None:
        self.config = config or SeedConfig()

    async def run(self) -> dict[str, Any]:
        stats = {
            "assets": {"inserted": 0, "updated": 0},
            "telegram_chats": {"inserted": 0, "updated": 0},
            "price_alerts": {"inserted": 0, "updated": 0},
        }

        async with AsyncSessionLocal() as db:
            if self.config.seed_assets:
                a = await self._seed_assets(db)
                stats["assets"] = a

            if self.config.seed_telegram_chats:
                t = await self._seed_telegram_chats(db)
                stats["telegram_chats"] = t

            if self.config.seed_price_alerts:
                p = await self._seed_price_alerts(db)
                stats["price_alerts"] = p

            await db.commit()

        return stats

    # ── Assets ────────────────────────────────────────────────────────────

    async def _seed_assets(self, db) -> dict[str, int]:
        inserted = 0
        updated = 0

        for rec in DEFAULT_ASSETS:
            symbol = str(rec["symbol"]).upper().strip()
            obj: Optional[Asset] = await db.get(Asset, symbol)

            if obj is None:
                obj = Asset(
                    symbol=symbol,
                    asset_class=str(rec.get("asset_class", "CRYPTO")),
                    name=str(rec.get("name", "")),
                    exchange=str(rec.get("exchange", "")),
                    active=bool(rec.get("active", True)),
                    last_price=None,
                    last_analysis_at=None,
                    meta=dict(rec.get("meta", {})),
                    created_at=_now_utc(),
                    updated_at=_now_utc(),
                )
                db.add(obj)
                inserted += 1
            else:
                obj.asset_class = str(rec.get("asset_class", obj.asset_class))
                obj.name = str(rec.get("name", obj.name))
                obj.exchange = str(rec.get("exchange", obj.exchange))
                obj.active = bool(rec.get("active", obj.active))
                # merge meta
                meta = dict(obj.meta or {})
                meta.update(dict(rec.get("meta", {})))
                obj.meta = meta
                obj.updated_at = _now_utc()
                updated += 1

        log.info("seed_assets_done", inserted=inserted, updated=updated)
        return {"inserted": inserted, "updated": updated}

    # ── Telegram chats ─────────────────────────────────────────────────────

    async def _seed_telegram_chats(self, db) -> dict[str, int]:
        inserted = 0
        updated = 0

        chat_ids = _env_list("IGNIS_SEED_TELEGRAM_CHAT_IDS") or _env_list("TELEGRAM_CHAT_IDS")
        if not chat_ids:
            log.info("seed_telegram_chats_skipped", reason="no_chat_ids_in_env")
            return {"inserted": 0, "updated": 0}

        min_priority = _env_str("IGNIS_SEED_TELEGRAM_MIN_PRIORITY", "MEDIUM").upper()
        silent_start = int(os.getenv("IGNIS_SEED_TELEGRAM_SILENT_START", "0"))
        silent_end = int(os.getenv("IGNIS_SEED_TELEGRAM_SILENT_END", "0"))

        for cid in chat_ids:
            chat_id = str(cid).strip()
            obj: Optional[TelegramChat] = await db.get(TelegramChat, chat_id)

            if obj is None:
                obj = TelegramChat(
                    chat_id=chat_id,
                    name="IGNIS Alerts",
                    active=True,
                    min_priority=min_priority,
                    symbol_whitelist=[],
                    timeframe_whitelist=[],
                    alert_type_blacklist=[],
                    silent_hours_start=silent_start,
                    silent_hours_end=silent_end,
                    created_at=_now_utc(),
                    updated_at=_now_utc(),
                )
                db.add(obj)
                inserted += 1
            else:
                obj.active = True
                obj.min_priority = min_priority
                obj.silent_hours_start = silent_start
                obj.silent_hours_end = silent_end
                obj.updated_at = _now_utc()
                updated += 1

        log.info("seed_telegram_chats_done", inserted=inserted, updated=updated)
        return {"inserted": inserted, "updated": updated}

    # ── Price alerts (demo) ────────────────────────────────────────────────

    async def _seed_price_alerts(self, db) -> dict[str, int]:
        """
        Seed d’alertes de prix de démonstration.
        Idempotence simple : si même symbol+threshold+direction existe, update label/active.
        """
        inserted = 0
        updated = 0

        demo = [
            {"symbol": "BTCUSDT", "threshold": 100000.0, "direction": "above", "label": "BTC breakout"},
            {"symbol": "ETHUSDT", "threshold": 5000.0, "direction": "above", "label": "ETH breakout"},
        ]

        for d in demo:
            symbol = d["symbol"].upper().strip()
            threshold = float(d["threshold"])
            direction = str(d["direction"]).lower().strip()

            q = select(PriceAlert).where(
                PriceAlert.symbol == symbol,
                PriceAlert.threshold == threshold,
                PriceAlert.direction == direction,
            )
            obj = (await db.execute(q)).scalars().first()

            if obj is None:
                obj = PriceAlert(
                    id=str(uuid4()),
                    symbol=symbol,
                    threshold=threshold,
                    direction=direction,
                    label=str(d.get("label", "")),
                    active=True,
                    created_at=_now_utc(),
                )
                db.add(obj)
                inserted += 1
            else:
                obj.label = str(d.get("label", obj.label))
                obj.active = True
                updated += 1

        log.info("seed_price_alerts_done", inserted=inserted, updated=updated)
        return {"inserted": inserted, "updated": updated}


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

async def main() -> None:
    # Ensure DB reachable (create_all optional)
    create_all = _env_bool("DB_CREATE_ALL", False)
    await init_db(create_all=create_all)

    cfg = SeedConfig(
        seed_assets=_env_bool("IGNIS_SEED_ASSETS", True),
        seed_telegram_chats=_env_bool("IGNIS_SEED_TELEGRAM_CHATS", True),
        seed_price_alerts=_env_bool("IGNIS_SEED_PRICE_ALERTS", False),
    )

    runner = SeedData(cfg)
    stats = await runner.run()
    log.info("seed_done", stats=stats)


if __name__ == "__main__":
    asyncio.run(main())
```