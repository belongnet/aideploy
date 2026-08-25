import unittest
from datetime import timedelta

from src.models import utc_now


class ModelTimestampTest(unittest.TestCase):
    def test_utc_now_returns_an_aware_utc_timestamp(self) -> None:
        timestamp = utc_now()

        self.assertIsNotNone(timestamp.tzinfo)
        self.assertEqual(timestamp.utcoffset(), timedelta(0))


if __name__ == "__main__":
    unittest.main()
