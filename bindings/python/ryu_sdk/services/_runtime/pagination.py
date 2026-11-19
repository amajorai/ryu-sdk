"""Cursor pagination over a namespace's list operations."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any, Callable, Optional

from ..config import ResolvedConfig
from .binding import Binding
from .drivers import _as_generator
from .steps import Emit


class Paginated:
    """Items one at a time across pages, plus ``collect()`` and ``pages()``.

    On ``Ryu`` use ``for item in ...``; on ``AsyncRyu`` use ``async for``.
    Iteration stops when the next cursor is ``None``, a page is empty,
    ``max_items`` is reached, or the server repeats a cursor.
    """

    def __init__(
        self,
        binding: Binding,
        fetch_page: Callable[[ResolvedConfig, Optional[str]], Any],
        items: Callable[[Any], list[Any]],
        next_cursor: Callable[[Any, Any], Optional[str]],
        *,
        key: Optional[Callable[[Any], str]] = None,
        max_items: Optional[int] = None,
    ) -> None:
        self._binding = binding
        self._fetch_page = fetch_page
        self._items = items
        self._next_cursor = next_cursor
        self._key = key
        self._max_items = max_items

    def _pages_op(self, config: ResolvedConfig) -> Any:
        cursor: Optional[str] = None
        seen: set[str] = set()
        while True:
            page = yield from _as_generator(self._fetch_page(config, cursor))
            yield Emit(page)
            items = self._items(page)
            if not items:
                return
            following = self._next_cursor(page, items[-1])
            if following is None or following in seen:
                return
            seen.add(following)
            cursor = following

    def _items_op(self, max_items: Optional[int]) -> Any:
        def op(config: ResolvedConfig) -> Any:
            if max_items is not None and max_items <= 0:
                return
            seen: set[str] = set()
            count = 0
            pages = self._pages_op(config)
            value: Any = None
            while True:
                try:
                    step = pages.send(value)
                except StopIteration:
                    return
                if not isinstance(step, Emit):
                    value = yield step
                    continue
                value = None
                for item in self._items(step.item):
                    if self._key is not None:
                        item_key = self._key(item)
                        if item_key in seen:
                            continue
                        seen.add(item_key)
                    yield Emit(item)
                    count += 1
                    if max_items is not None and count >= max_items:
                        return

        return op

    def __iter__(self) -> Iterator[Any]:
        if self._binding.is_async:
            raise TypeError("use `async for` with AsyncRyu")
        return iter(self._binding.stream(self._items_op(self._max_items)))

    def __aiter__(self) -> Any:
        if not self._binding.is_async:
            raise TypeError("use `for` with Ryu (or AsyncRyu for `async for`)")
        return self._binding.stream(self._items_op(self._max_items)).__aiter__()

    def pages(self) -> Any:
        """Raw pages, in order (an iterator, or an async iterator on ``AsyncRyu``)."""
        return self._binding.stream(lambda config: self._pages_op(config))

    def collect(self, max_items: Optional[int] = None) -> Any:
        """Up to ``max_items`` items (default: the ``max_items`` given to ``iterate``, else all)."""
        limit = max_items if max_items is not None else self._max_items
        stream = self._binding.stream(self._items_op(limit))
        if self._binding.is_async:

            async def gather() -> list[Any]:
                return [item async for item in stream]

            return gather()
        return list(stream)


def next_cursor_field(page: Any, _last: Any = None) -> Optional[str]:
    """``nextCursor`` reader for pages shaped ``{"nextCursor": ...}``."""
    value = page.get("nextCursor") if isinstance(page, dict) else None
    return value if isinstance(value, str) and value else None
