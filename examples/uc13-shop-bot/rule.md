# Keyword rule (written 2026-10-01, before any arm ran)
Case-insensitive. If the message matches any of these, the rule answers `hand_off`; otherwise `answer`.

available, availability, in stock, stock, left, book, booked, booking, reserve, reservation, hold, confirm, confirmed, cancel, refund, deposit, damage, broke, broken, charged, hurt, injur, avalanche, safe, danger, this weekend, saturday, sunday, tomorrow

Source: UC13 "any stock, availability or booking word goes to hand off", plus the policy, injury and safety words a builder would add on day one. Word-boundary match at the start of each term.
