import importlib.util
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('backfill', 'scripts/backfill.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


class ImportTests(unittest.TestCase):
    def market(self, **changes):
        raw = dict(id='1', question='Paris: Player One vs Player Two', sportsMarketType='moneyline',
                   outcomes='["Player One","Player Two"]', clobTokenIds='["123","456"]',
                   gameStartTime='2026-01-05 12:00:00+00', volumeNum=5001, slug='atp-one-two',
                   endDate='2026-02-20T00:00:00Z', events=[])
        raw.update(changes)
        return b.normalize(raw, b.stamp('2026-01-01T00:00:00Z'), b.stamp('2026-01-31T23:59:59Z'))

    def test_strict_volume_and_match_date_not_expiry(self):
        self.assertIsNotNone(self.market()[0])
        self.assertEqual(self.market(volumeNum=5000)[1], 'volume_at_or_below_5000')
        self.assertEqual(self.market(gameStartTime='2025-12-31T23:59:59Z')[1], 'outside_match_dates')
        self.assertEqual(self.market(volumeNum=float('nan'))[1], 'volume_at_or_below_5000')

    def test_doubles_and_side_markets_excluded(self):
        self.assertEqual(self.market(outcomes='["A / B","C / D"]')[1], 'doubles')
        self.assertEqual(self.market(question='Doubles: A vs B')[1], 'doubles')
        self.assertEqual(self.market(sportsMarketType='tennis_completed_match')[1], 'not_match_winner')
        self.assertEqual(self.market(outcomes='["Yes","No"]')[1], 'not_two_players')

    def test_missing_dates_and_malformed_outcomes(self):
        self.assertEqual(self.market(gameStartTime=None)[1], 'missing_match_time')
        self.assertEqual(self.market(outcomes='not json')[1], 'not_two_players')

    def test_timezone_offsets(self):
        self.assertEqual(b.stamp('2026-01-05T13:00:00+01:00'), b.stamp('2026-01-05T12:00:00Z'))

    def test_history_cursor_settlement_filter_and_deduplication(self):
        pages = [
            dict(data=[dict(timestamp=100, price=.4, resolution_seconds=10800),
                       dict(timestamp=120, price=1, resolution_seconds=0)],
                 pagination=dict(next_cursor='next', has_more=True)),
            dict(data=[dict(timestamp=100, price=.4, resolution_seconds=10800),
                       dict(timestamp=150, price=.5, resolution_seconds=10800),
                       dict(timestamp=300, price=.6, resolution_seconds=10800)],
                 pagination=dict(next_cursor=None, has_more=False)),
        ]
        with patch.object(b, 'request', side_effect=pages) as request:
            rows = b.token_history('token', {}, 90, 11000, 10800)
            self.assertEqual(rows, [[100, .4, 10800], [150, .5, 10800]])
            self.assertEqual(request.call_args.args[1]['cursor'], 'next')

    def test_missing_cursor_is_error_not_success(self):
        with patch.object(b, 'request', return_value=dict(data=[], pagination=dict(has_more=True))):
            with self.assertRaises(RuntimeError):
                b.token_history('token', {}, 90, 200, 10800)

    def test_closed_time_bounds_fine_history(self):
        with patch.object(b, 'request', return_value=dict(data=[], pagination=dict(next_cursor=None, has_more=False))) as request:
            b.token_history('token', dict(listedAt=100000, matchTime=120000, closedTime=130000, endTime=900000), 1, 2000000, 900)
            self.assertEqual(request.call_count, 1)
            self.assertEqual(request.call_args.args[1]['end'], 216400)

    def test_pre_match_excludes_buckets_spanning_start(self):
        self.assertTrue(b.pre_match([100, .5, 900], 1000))
        self.assertFalse(b.pre_match([101, .5, 900], 1000))
        self.assertFalse(b.pre_match([1000, .5, 900], 1000))
        self.assertFalse(b.pre_match([100, 1, 0], 1000))

    def test_volume_precision_is_preserved(self):
        self.assertEqual(self.market(volumeNum=5000.001)[0]['volume'], 5000.001)


if __name__ == '__main__':
    unittest.main()
