#!/usr/bin/env python3
import unittest

from cobble_data_api import (
    _find_cobbledollars_balance_json,
    parse_badges_from_nbt,
    parse_pokedex,
)


class ParsePokedexTest(unittest.TestCase):
    def test_counts_caught_and_seen(self):
        data = {
            "pokedex": {
                "species": [
                    {"id": "pidgey", "knowledge": "caught"},
                    {"id": "rattata", "knowledge": "SEEN"},
                    {"id": "unrelated", "notKnowledge": "ignored"},
                ],
                "nested": {"deeper": {"knowledge": 123}},
            }
        }
        result = parse_pokedex(data)
        self.assertEqual(result, {"caught": 1, "seen": 2, "total": 1025})


class ParseBadgesFromNbtTest(unittest.TestCase):
    def test_collects_dedupes_and_excludes_box(self):
        player_nbt = {
            "Inventory": [
                {"id": "cobbleversebadges:kanto_boulder_badge", "Count": 1},
                {"id": "cobbleversebadges:kanto_cascade_badge", "Count": 1},
                {
                    "id": "cobbleversebadges:kanto_badge_box",
                    "Count": 1,
                    "tag": {
                        "BlockEntityTag": {
                            "Items": [
                                {
                                    "id": "cobbleversebadges:kanto_boulder_badge",
                                    "Count": 1,
                                },
                                {
                                    "id": "cobbleversebadges:johto_zephyr_badge",
                                    "Count": 1,
                                },
                            ]
                        }
                    },
                },
                {"id": "minecraft:stone", "Count": 64},
            ]
        }
        result = parse_badges_from_nbt(player_nbt, "cobbleversebadges:")
        self.assertEqual(
            result,
            {
                "count": 3,
                "list": [
                    "cobbleversebadges:johto_zephyr_badge",
                    "cobbleversebadges:kanto_boulder_badge",
                    "cobbleversebadges:kanto_cascade_badge",
                ],
            },
        )


class FindCobbledollarsBalanceJsonTest(unittest.TestCase):
    def test_depth_first_finds_balance(self):
        data = {
            "player": {
                "meta": {"version": 1},
                "wallet": {"balance": 4200},
            }
        }
        self.assertEqual(_find_cobbledollars_balance_json(data), 4200)

    def test_returns_none_when_absent(self):
        data = {"player": {"meta": {"version": 1}}}
        self.assertIsNone(_find_cobbledollars_balance_json(data))


if __name__ == "__main__":
    unittest.main()
