"""Vercel Queues abonesi: link cozumleme (docs/decisions/0107).

Vercel, `pyproject.toml`'daki `[[tool.vercel.subscribers]]` girdisinden bu
modulu derleme aninda iceri alir ve `@subscribe` kaydini ozel, kuyruk
tetiklemeli bir fonksiyona cevirir. Herkese acik rota YOKTUR; web bu
fonksiyonu cagirmaz, yalnizca `link-resolution` topic'ine `request_id` birakir
(`packages/core/src/discovery/link-queue.ts`).

Mantik `queue_handler.handle_message`'dadir (SDK'dan bagimsiz test edilir);
burasi yalnizca `TransientFailure`'u platformun yeniden deneme yonergesine
(`RetryAfter`) cevirir. Normal donus mesaji onaylar.

Yuk tiplenmemis birakilir (`Message`): tipli abonelik `pydantic` ister ve
`handle_message` yukun bicimini kendisi dogrular.
"""

from __future__ import annotations

from vercel.queue import Message, RetryAfter, subscribe

from collect.link.queue_handler import (
    LINK_TOPIC,
    MAX_ATTEMPTS,
    MAX_CONCURRENCY,
    RETRY_BASE_SECONDS,
    TransientFailure,
    handle_message,
)


@subscribe(
    topic=LINK_TOPIC,
    max_concurrency=MAX_CONCURRENCY,
    max_attempts=MAX_ATTEMPTS,
    retry_after=RETRY_BASE_SECONDS,
)
def resolve_link(message: Message) -> None:
    try:
        handle_message(message.payload, message.metadata.delivery_count)
    except TransientFailure as failure:
        raise RetryAfter(failure.delay, reason=str(failure)) from failure
