"""The settings and HTTP client one ``Ryu`` / ``AsyncRyu`` instance shares across services."""

from __future__ import annotations

from typing import Optional

from ..errors import RyuConfigurationError
from .client_state import ClientState
from .engine import Engine


class ClientCore(ClientState):
    """Settings and the HTTP client one ``Ryu`` / ``AsyncRyu`` instance shares across services."""

    def engine(self, service: str, credentials: str = "required") -> Engine:
        """The service's engine. ``credentials="optional"`` resolves a credential-free config
        (Messaging ``status()``) when the credentials are missing."""
        cache_key = f"{service}:optional" if credentials == "optional" else service
        engine = self._engines.get(cache_key)
        if engine is None:
            engine = Engine(self, self.settings.resolve(service, credentials=credentials))
            self._engines[cache_key] = engine
        return engine

    def call_engine(self, service: str, method: Optional[str] = None) -> Engine:
        """The engine for one call: a method the service lists as credential-free falls back to a
        config without credentials when strict resolution fails (``resolveCallConfig``)."""
        try:
            return self.engine(service)
        except RyuConfigurationError:
            if method is None or method not in self.credential_free.get(service, ()):
                raise
            return self.engine(service, credentials="optional")
