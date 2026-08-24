import os
import unittest
import uuid
from unittest.mock import patch
from src.bus_client import BusClient
from src.models import BusChannel, BusEventType
from src.supabase_bus import SupabaseBusAdapter

class _FakePool:

    async def fetchval(self, _query: str, *args):
        self.args = args
        return 42

class _FakeRealtimeAdapter:

    def __init__(self) -> None:
        self.enabled = True
        self.calls: list[dict[str, object]] = []

    async def publish(self, *, channel: str, payload: dict, user_id: str | None=None):
        self.calls.append({'channel': channel, 'payload': payload, 'user_id': user_id})
        return 'row-1'

class SupabaseBusAdapterTest(unittest.TestCase):

    def test_enabled_by_default(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            adapter = SupabaseBusAdapter('postgresql://example', uuid.uuid4())
        self.assertTrue(adapter.enabled)

    def test_disable_flag_turns_mirroring_off(self) -> None:
        with patch.dict(os.environ, {'SUPABASE_BUS_ENABLED': 'false'}, clear=True):
            adapter = SupabaseBusAdapter('postgresql://example', uuid.uuid4())
        self.assertFalse(adapter.enabled)

class BusClientMirrorTest(unittest.IsolatedAsyncioTestCase):
    pass
if __name__ == '__main__':
    unittest.main()
