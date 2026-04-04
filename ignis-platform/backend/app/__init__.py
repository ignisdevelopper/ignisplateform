"""
╔══════════════════════════════════════════════════════════════════════════════╗
║                                                                              ║
║   🔥  IGNIS PLATFORM  —  Supply & Demand Intelligence Engine                ║
║                                                                              ║
║   Version      : 1.0.0                                                       ║
║   Stack        : FastAPI + SQLAlchemy + PostgreSQL + Redis + Ollama          ║
║   Strategy     : Supply & Demand (SDE / SGB / SDP / FLIPPY / PA)            ║
║   Author       : Ignis Team                                                  ║
║   Description  : Backend principal — détection automatique de zones S&D,    ║
║                  analyse multi-timeframe, scoring de setups, IA intégrée     ║
║                  (Ollama), alertes Telegram, WebSocket temps réel.           ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝

Architecture des modules
────────────────────────
app/
├── main.py                  FastAPI application entry point
├── config.py                Settings, env vars, feature flags
│
├── api/                     Routes HTTP
│   ├── routes_analysis.py   POST /analyze/{symbol} → pipeline complet
│   ├── routes_assets.py     GET /assets → liste + statut setup
│   ├── routes_alerts.py     GET/POST /alerts → gestion alertes
│   ├── routes_ignis_ai.py   POST /ai/chat → chat Ollama
│   └── routes_journal.py    CRUD /journal → journal de trade
│
├── core/                    🔥 Moteur stratégie S&D
│   ├── market_structure/    Phase Rally/Drop, HH/HL/LH/LL, SB, MTF
│   ├── base_engine/         RBR/DBD/RBD/DBR, scorer, WB, HB
│   ├── sd_zones/            SDE, SGB, SDP, FLIPPY, FTB, Failed SDE
│   ├── pa_patterns/         ACCU, 3 Drives, FTL, 69, Hidden SDE
│   ├── advanced_patterns/   Over&Under, IOU, Flag Limit, Counter Attack
│   ├── decision_point/      DP types, Key Levels, SL/TP, Pullback Entry
│   └── setup_scanner/       Validator, Scorer, Pipeline orchestrateur
│
├── ignis_ai/                🤖 IA locale Ollama
│   ├── ollama_client.py     Connexion + streaming
│   ├── prompt_builder.py    Prompt engineering S&D
│   ├── report_generator.py  Rapport d'analyse complet
│   └── chat_handler.py      Chat temps réel WebSocket
│
├── data/                    Sources de données
│   ├── binance_fetcher.py   OHLCV crypto (Binance API)
│   ├── yahoo_fetcher.py     Actions / Forex / Indices (yfinance)
│   ├── data_normalizer.py   Format unifié Candle
│   └── cache_manager.py     Redis + fallback mémoire
│
├── alerts/                  Système d'alertes
│   ├── alert_engine.py      Règles de déclenchement
│   ├── telegram_bot.py      Envoi Telegram Bot API
│   └── websocket_manager.py Push WebSocket vers frontend
│
├── db/                      Base de données
│   ├── models.py            SQLAlchemy ORM models
│   ├── database.py          Engine PostgreSQL + session
│   └── migrations/          Alembic
│
└── utils/                   Helpers
    ├── candle_utils.py       Manipulation bougies OHLCV
    ├── math_utils.py         Calculs prix, RR, pivots
    └── logger.py             Logging structuré (structlog)

Conventions de code
────────────────────
- Tous les prix sont en float64 (numpy)
- Les timeframes sont représentés en minutes : M1=1, M5=5, M15=15,
  H1=60, H4=240, D1=1440, W1=10080
- Les bougies suivent le modèle Candle (voir db/models.py)
- Les zones S&D retournent toujours un SDZone avec score [0-100]
- Les setups retournent un SetupResult avec statut VALID / PENDING / INVALID
- Tous les détecteurs sont stateless et prennent List[Candle] en entrée

Glossaire S&D
─────────────
  SDE   Significant Demand Engulfed — bougie haussière qui englobe la base
  SGB   Significant Base — zone d'entrée principale créée avant le SDE
  SDP   Successful Decision Point — HEAD tenu, point décisionnel validé
  FTB   First Time Back — 1er retour sur une zone S&D
  WB    Weakening Base — base fragilisée par retours multiples
  HB    Hidden Base — base cachée, détectée via LTF (kissing candle)
  FLIPPY Zone de manipulation — ancienne S devenue D ou vice versa
  PA    Price Approaching — pattern d'approche de zone (ACCU, 3D, FTL…)
  DP    Decision Point — niveau décisionnel (RBR/DBR SB, SDP, Trend Line)
  KL    Key Level — niveau clé (old high, round number, S/R flip)
  OU    Over & Under — dépassement de zone suivi de rejet (Golden Zone)
  IOU   Ignored Over & Under — OU ignoré → signal fort
  3D    Three Drives — 3 impulsions convergentes vers la zone
  FTL   Flip Trend Line — ligne de tendance retournée en support/résistance
  HTF   Higher Time Frame (D1, W1, H4)
  LTF   Lower Time Frame (M15, M5, M1)
  RR    Risk/Reward ratio
  SB    Structure Breaker — cassure de structure de marché
  HH/HL Higher High / Higher Low (tendance haussière)
  LH/LL Lower High / Lower Low (tendance baissière)
"""

# ── Version sémantique ─────────────────────────────────────────────────────────
__version__ = "1.0.0"
__version_info__ = (1, 0, 0)
__codename__ = "Phoenix"

# ── Métadonnées du package ─────────────────────────────────────────────────────
__title__ = "Ignis Platform"
__description__ = "Supply & Demand Intelligence Engine — Analyse automatique de zones S&D"
__author__ = "Ignis Team"
__license__ = "Proprietary"
__url__ = "https://ignis.trade"

# ── Timeframes supportés (en minutes) ─────────────────────────────────────────
TIMEFRAMES = {
    "M1":    1,
    "M5":    5,
    "M15":   15,
    "M30":   30,
    "H1":    60,
    "H2":    120,
    "H4":    240,
    "H8":    480,
    "D1":    1440,
    "W1":    10080,
    "MN1":   43200,
}

# Hiérarchie HTF → LTF pour analyse multi-timeframe
TIMEFRAME_HIERARCHY = [
    "MN1", "W1", "D1", "H8", "H4", "H2", "H1", "M30", "M15", "M5", "M1"
]

# ── Classes d'actifs supportées ────────────────────────────────────────────────
ASSET_CLASSES = {
    "CRYPTO":  "Cryptomonnaies (Binance)",
    "FOREX":   "Paires de devises (Yahoo Finance)",
    "STOCKS":  "Actions (Yahoo Finance)",
    "INDICES": "Indices boursiers (Yahoo Finance)",
    "COMMODITIES": "Matières premières (Yahoo Finance)",
}

# ── Statuts de setup ───────────────────────────────────────────────────────────
class SetupStatus:
    VALID   = "VALID"     # SB + SDE + SGB + SDP + PA + DP + KL tous alignés
    PENDING = "PENDING"   # SDE trouvé, en attente SGB ou prix en route vers DP
    INVALID = "INVALID"   # HEAD vient de FLIPPY, FTB déjà pris, ou DDP présent
    WATCH   = "WATCH"     # Zone identifiée, surveillance en cours
    EXPIRED = "EXPIRED"   # Zone invalidée (prix l'a traversée)

# ── Types de zones S&D ─────────────────────────────────────────────────────────
class ZoneType:
    DEMAND       = "DEMAND"        # Zone de demande (support)
    SUPPLY       = "SUPPLY"        # Zone d'offre (résistance)
    FLIPPY_D     = "FLIPPY_D"      # Ancienne supply devenue demand
    FLIPPY_S     = "FLIPPY_S"      # Ancienne demand devenue supply
    HIDDEN_D     = "HIDDEN_D"      # Demand cachée (LTF)
    HIDDEN_S     = "HIDDEN_S"      # Supply cachée (LTF)

# ── Types de base ──────────────────────────────────────────────────────────────
class BaseType:
    RBR = "RBR"   # Rally-Base-Rally (continuation haussière)
    DBD = "DBD"   # Drop-Base-Drop  (continuation baissière)
    RBD = "RBD"   # Rally-Base-Drop (retournement bearish)
    DBR = "DBR"   # Drop-Base-Rally (retournement bullish)

# ── Types de patterns PA ───────────────────────────────────────────────────────
class PAPattern:
    ACCU          = "ACCU"          # Accumulation escalier
    THREE_DRIVES  = "THREE_DRIVES"  # 3 Drives (le plus puissant)
    FTL           = "FTL"           # Flip Trend Line
    PATTERN_69    = "PATTERN_69"    # 69 (FLIPPY + SDE + SGB)
    HIDDEN_SDE    = "HIDDEN_SDE"    # FBO + FLIPPY detect
    NONE          = "NONE"          # Pas de PA détecté

# ── Types de Decision Point ────────────────────────────────────────────────────
class DPType:
    SDP           = "SDP"           # Successful Decision Point (HEAD tenu)
    SB_LEVEL      = "SB_LEVEL"      # Niveau Structure Breaker
    TREND_LINE    = "TREND_LINE"    # Ligne de tendance retournée
    KEY_LEVEL     = "KEY_LEVEL"     # Old high/low, round number, S/R flip

# ── Phases de marché ───────────────────────────────────────────────────────────
class MarketPhase:
    RALLY  = "RALLY"   # Tendance haussière impulsive
    DROP   = "DROP"    # Tendance baissière impulsive
    BASE   = "BASE"    # Consolidation / zone de base
    CHOP   = "CHOP"    # Marché sans direction claire

# ── Seuils de scoring (configurable via config.py) ────────────────────────────
SCORING_THRESHOLDS = {
    "BASE_SOLID_MIN":        70,   # Score minimum pour une base solide
    "BASE_WEAK_MAX":         40,   # Score maximum pour une base faible
    "ENGULFMENT_MIN":        0.85, # Ratio minimum d'englobement SDE
    "FTB_MAX_TOUCHES":       2,    # Nombre max de touches pour FTB valide
    "PA_STRENGTH_3D":        95,   # Force du pattern 3 Drives
    "PA_STRENGTH_ACCU":      75,   # Force du pattern ACCU
    "PA_STRENGTH_FTL":       80,   # Force du pattern FTL
    "PA_STRENGTH_69":        90,   # Force du pattern 69
    "PA_STRENGTH_HIDDEN":    85,   # Force du Hidden SDE
    "SETUP_VALID_THRESHOLD": 75,   # Score global minimum pour VALID
    "RR_MIN":                2.0,  # Risk/Reward minimum acceptable
    "SDP_HEAD_TOLERANCE":    0.002, # Tolérance HEAD tenu (0.2%)
    "KEY_LEVEL_PROXIMITY":   0.003, # Proximité Key Level (0.3%)
}

# ── Configuration WebSocket ────────────────────────────────────────────────────
WEBSOCKET_CONFIG = {
    "PING_INTERVAL":    25,    # secondes
    "PING_TIMEOUT":     10,    # secondes
    "MAX_CONNECTIONS":  500,   # connexions simultanées max
    "MESSAGE_QUEUE":    1000,  # taille queue de messages
}

# ── Configuration Cache ────────────────────────────────────────────────────────
CACHE_CONFIG = {
    "CANDLES_TTL":     300,    # 5 minutes — données OHLCV
    "ANALYSIS_TTL":    60,     # 1 minute — résultat d'analyse
    "SETUP_TTL":       120,    # 2 minutes — statut setup
    "ASSET_LIST_TTL":  3600,   # 1 heure — liste d'actifs
}

# ── Limites de l'API ───────────────────────────────────────────────────────────
API_LIMITS = {
    "MAX_CANDLES_PER_REQUEST":  5000,
    "MAX_SYMBOLS_WATCH":        50,
    "MAX_ALERTS_PER_USER":      200,
    "RATE_LIMIT_PER_MINUTE":    120,
    "ANALYSIS_TIMEOUT_SECONDS": 30,
}

# ── Import des sous-modules (lazy, pour éviter les imports circulaires) ────────
# Les sous-modules sont importés explicitement dans main.py via les routers.
# Ce fichier expose uniquement les constantes et enums globaux.

__all__ = [
    # Version
    "__version__",
    "__version_info__",
    "__codename__",
    "__title__",
    "__description__",

    # Timeframes
    "TIMEFRAMES",
    "TIMEFRAME_HIERARCHY",

    # Asset classes
    "ASSET_CLASSES",

    # Enums / classes constantes
    "SetupStatus",
    "ZoneType",
    "BaseType",
    "PAPattern",
    "DPType",
    "MarketPhase",

    # Configuration
    "SCORING_THRESHOLDS",
    "WEBSOCKET_CONFIG",
    "CACHE_CONFIG",
    "API_LIMITS",
]