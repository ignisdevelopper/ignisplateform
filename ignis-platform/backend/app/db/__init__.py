"""
db/migrations/__init__.py — Migrations DB IGNIS (Alembic)

Ce dossier est géré par Alembic.
- Les fichiers de migration sont générés automatiquement (versions/*).
- Ce __init__ existe surtout pour permettre des imports optionnels / tooling.

Note :
En prod, on utilise généralement :
    alembic upgrade head
depuis la racine backend (où se trouve alembic.ini).
"""

__all__ = []