from dataclasses import dataclass, field
from typing import Mapping


@dataclass(frozen=True)
class AIModelContext:
    """Données minimisées transmissibles à un provider, sans identifiant de compte."""

    profile_preferences: Mapping[str, object] = field(default_factory=dict)
    temporary_context: Mapping[str, object] = field(default_factory=dict)
    memory: Mapping[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class AIContext:
    """Contexte interne à une requête; ne contient aucun credential."""

    user_id: str
    profile_preferences: Mapping[str, object] = field(default_factory=dict)
    temporary_context: Mapping[str, object] = field(default_factory=dict)
    memory: Mapping[str, object] = field(default_factory=dict)

    def for_provider(self) -> AIModelContext:
        return AIModelContext(
            profile_preferences=self.profile_preferences,
            temporary_context=self.temporary_context,
            memory=self.memory,
        )