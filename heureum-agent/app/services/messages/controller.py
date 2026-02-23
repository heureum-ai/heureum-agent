# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Message-domain composition root controller."""

from app.services.messages.clients import MessageRehydrationController, PlatformMessageHistoryClient
from app.services.messages.history import HistoryMessageController
from app.services.messages.normalize import MessageNormalizeController
from app.services.messages.persist import PersistController
from app.services.messages.responses import ResponseMessageController
from app.services.messages.sessions import SessionStateController


class MessageController:
    """Main composition root for all message-domain controllers."""

    def __init__(self) -> None:
        self.message_normalize_controller = MessageNormalizeController()
        self.response_message_controller = ResponseMessageController()
        self.history_message_controller = HistoryMessageController(
            normalizer=self.message_normalize_controller,
            responses=self.response_message_controller,
        )
        self.session_state_controller = SessionStateController()
        self.message_rehydration_controller = MessageRehydrationController(
            normalizer=self.message_normalize_controller,
        )
        self.persist_controller: PersistController | None = None

    def init_persist(self, platform_api_url: str) -> PersistController:
        """Lazily initialize the persist sub-controller."""
        self.persist_controller = PersistController(platform_api_url)
        return self.persist_controller

    def create_platform_message_history_client(
        self,
        platform_api_url: str,
    ) -> PlatformMessageHistoryClient:
        """Create a Platform message-history client."""
        return PlatformMessageHistoryClient(platform_api_url=platform_api_url)
