"""
ignis_ai/__init__.py — Package Ignis AI (Ollama local)

Expose les composants IA :
- ollama_client.py     : client Ollama (chat / generate / streaming)
- prompt_builder.py    : construction des prompts HLZ / S&D
- report_generator.py  : génération de rapports d'analyse
- chat_handler.py      : gestion du chat temps réel (WebSocket / streaming)

Le package est consommé par :
- api/routes_ignis_ai.py
- (optionnel) core/setup_scanner/setup_pipeline.py pour enrichissement IA
"""

from app.ignis_ai.ollama_client import (
    OllamaClient,
    OllamaClientConfig,
    OllamaChatMessage,
    OllamaChatResponse,
    OllamaGenerateResponse,
)

from app.ignis_ai.prompt_builder import (
    PromptBuilder,
    PromptContext,
)

from app.ignis_ai.report_generator import (
    ReportGenerator,
    ReportConfig,
    ReportResult,
)

from app.ignis_ai.chat_handler import (
    IgnisChatHandler,
    ChatSession,
    ChatConfig,
)

IGNIS_AI_COMPONENTS = {
    "OLLAMA_CLIENT": OllamaClient,
    "PROMPT_BUILDER": PromptBuilder,
    "REPORT_GENERATOR": ReportGenerator,
    "CHAT_HANDLER": IgnisChatHandler,
}

__all__ = [
    # Ollama client
    "OllamaClient",
    "OllamaClientConfig",
    "OllamaChatMessage",
    "OllamaChatResponse",
    "OllamaGenerateResponse",

    # Prompt builder
    "PromptBuilder",
    "PromptContext",

    # Report generator
    "ReportGenerator",
    "ReportConfig",
    "ReportResult",

    # Chat handler
    "IgnisChatHandler",
    "ChatSession",
    "ChatConfig",

    # Registry
    "IGNIS_AI_COMPONENTS",
]