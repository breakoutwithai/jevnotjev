/**
 * The five Backstage calibration cases (labelling loop M3): UC13 shop-bot messages with the truths a person approved on
 * 2026-10-03 (docs/product/runs/2026-10-01-uc13-shop-bot/LABELS.md). Three AI labellers drafted those truths and a
 * person reviewed and approved them, so each reference is human_reviewed, labelled by operator, not blind.
 *
 * Chosen to be clear-cut: none is one of the five least certain calls listed for review (m07, m12, m28, m33, m35).
 * Two are answer, three hand_off; one (m26, snowshoes) has no rule word, so it tests reading the fact sheet.
 * src/labels/calibration.test.ts checks every text and truth against the run's own files.
 */
import type { CalibrationCase, CalibrationSet } from "./calibration.ts";

function approved(id: string, input: string, truth: "answer" | "hand_off"): CalibrationCase {
  return Object.freeze({ id, input, truth, source: "human_reviewed", labelledBy: "operator", labelledAt: "2026-10-03" });
}

export const UC13_FACT_SHEET =
  "Shop: Larchfield Ski & Board Rentals (a synthetic shop written for this test). Locations: Larchfield Village (main counter) and Upper Larchfield (lift-base express counter). Hours: daily 7:30 AM to 7:00 PM. Phone: 555-0142. After-hours gear return: drop locker by the main door, open 24/7.\n" +
  "Rentals per day: performance demo skis (Northpeak, Stellar, Halden, Corvo) $75; Corvo Freeride 106 twin $75; splitboard package (skins, poles, bindings) $85; recreational resort skis $52; junior complete package, ages 4 to 12, free size swaps, $32; avalanche safety kit (beacon, probe, shovel) $35. Multi-day discount: 15% off 3 or more days.\n" +
  "Tuning: full overhaul (base weld, stone grind, edge bevel, hot wax) $65; standard edge and wax $45; 15-minute counter wax $25. Drop off by 5:00 PM for 8:00 AM pickup.\n" +
  "Guarantees: Early Lift promise (gear tuned and racked before you arrive, in and out under 5 minutes); free condition swaps on demo rentals; boot comfort guarantee (heat-molded fitting, immediate swap if boots hurt during the trip); bindings release-tested on a certified bench before every rental.\n" +
  "Not on this sheet: live stock or availability, bookings, deposits, damage charges, cancellations and refunds, junior size ranges, retail products, forecasts.";

export const UC13_QUESTION =
  "Can the bot answer this customer message using only the fact sheet, or must it hand off to staff?";

export const UC13_CHOICES: CalibrationSet["choices"] = Object.freeze([
  Object.freeze({
    name: "answer",
    definition:
      "Everything the customer asks is covered by the fact sheet, so the bot can reply without promising stock, availability, a booking, or anything the sheet does not state.",
  }),
  Object.freeze({
    name: "hand_off",
    definition:
      "The message needs live stock or availability, a booking or reservation, a policy or fact not on the sheet, a safety judgement, or a complaint, injury or billing problem, so staff must answer.",
  }),
]);

export const UC13_CALIBRATION: CalibrationSet = Object.freeze({
  question: UC13_QUESTION,
  choices: UC13_CHOICES,
  context: UC13_FACT_SHEET,
  cases: Object.freeze([
    approved("m16", "What time do you open in the morning?", "answer"),
    approved("m10", "I booked online last night. Is my order confirmed?", "hand_off"),
    approved("m29", "How much is a recreational ski rental per day?", "answer"),
    approved("m26", "Do you rent snowshoes?", "hand_off"),
    approved("m19", "I was charged twice on my card for Tuesday's rental.", "hand_off"),
  ]),
});
